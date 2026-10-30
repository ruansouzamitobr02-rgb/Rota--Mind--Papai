import { BotService } from "./connection";
import { shutdownIsolatedOcrWorker } from "./ocrIsolated";
import { compactPanelSnapshot } from "./panelSnapshot";
import { BotWorkerIncomingMessage, BotWorkerOutgoingMessage } from "./botProcessProtocol";
import os from "os";

const ALLOWED_METHODS = new Set([
  "getAnalysisPreview",
  "start",
  "stop",
  "restart",
  "clearSession",
  "refreshQrCode",
  "factoryReset",
  "clearLogs",
  "clearRouteHistory",
  "refreshGroups",
  "enableMonitoring",
  "enableImageMonitoring",
  "enableNuclearMonitoring",
  "enableTestMonitoring",
  "disableMonitoring",
  "simulateOpening",
  "manualDispatch",
  "simulateTargetDispatchOnTestGroup",
  "runLatencyProbeOnTestGroup",
  "warmupConnection",
  "saveGroup",
  "saveTestGroup",
  "setMessageCodes",
  "setMessageSettings",
  "setWarmupMessageSettings",
  "setDispatchPriorityLevel",
  "setDispatchPriorityDelayMs",
  "saveRoutePreset",
  "deleteRoutePreset",
  "setGeneralSettings",
  "confirmOcrRouteSelection",
  "submitClientIncident",
  "snoozeClientIncident",
  "validateRoute",
  "rejectRoute",
  "setLeaderContacts",
  "locateRomaneioInGroup",
  "confirmRomaneioCandidate"
]);

let bot: BotService | undefined;
let snapshotTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let reportedCritical = false;
let callQueue = Promise.resolve();
let workerClientEmail = "";
let dispatchGateSequence = 0;
const pendingDispatchGates = new Map<string, {
  resolve: (grant: { token: string; waitedMs: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

// Tente favorecer o processo que mantÃ©m o socket. Render pode negar prioridade
// negativa; nesse caso o worker segue na prioridade normal e o OCR fica em +10.
try {
  os.setPriority(process.pid, -5);
} catch {
  try {
    os.setPriority(process.pid, 0);
  } catch {
    // Sem suporte do sistema operacional.
  }
}

function send(message: BotWorkerOutgoingMessage) {
  if ("snapshot" in message && message.snapshot) {
    message = { ...message, snapshot: compactPanelSnapshot(message.snapshot, workerClientEmail) };
  }
  if (process.connected) process.send?.(message);
}

function scheduleSnapshot() {
  if (!bot || snapshotTimer) return;
  const critical = bot.isCriticalDispatchActive();
  if (critical && !reportedCritical) {
    reportedCritical = true;
    send({ type: "snapshot-dirty", critical: true });
  }
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined;
    if (!bot) return;
    if (bot.isCriticalDispatchActive()) {
      scheduleSnapshot();
      return;
    }
    reportedCritical = false;
    send({ type: "snapshot", snapshot: bot.getSnapshot() });
  }, critical ? 100 : 20);
  snapshotTimer.unref?.();
}

async function initialize(message: Extract<BotWorkerIncomingMessage, { type: "init" }>) {
  if (bot) return;
  workerClientEmail = message.options.clientEmail || "";
  bot = new BotService({ ...message.options, deferSnapshotPayload: true });
  bot.on("snapshot", scheduleSnapshot);
  bot.on("image-analysis", (analysis) => {
    setImmediate(() => send({ type: "image-analysis", analysis }));
  });
  bot.on("route-auto-validated", (validation) => {
    setImmediate(() => send({ type: "route-auto-validated", ...validation }));
  });
  bot.setDispatchGateHandlers(
    (request) => {
      const id = `${process.pid}-${Date.now()}-${++dispatchGateSequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingDispatchGates.delete(id);
          reject(new Error("O ciclo do grupo expirou antes do envio."));
        }, 125_000);
        timer.unref?.();
        pendingDispatchGates.set(id, { resolve, reject, timer });
        send({ type: "dispatch-gate-request", id, ...request });
      });
    },
    (token, clientEmail, relayedAt) => send({ type: "dispatch-gate-relay", token, clientEmail, relayedAt }),
    (token, clientEmail, failedAt) => send({ type: "dispatch-gate-failure", token, clientEmail, failedAt }),
    (event) => send({ type: "dispatch-race-event", ...event })
  );
  send({ type: "ready", snapshot: bot.getSnapshot() });
}

async function handleCall(message: Extract<BotWorkerIncomingMessage, { type: "call" }>) {
  if (!bot) throw new Error("Worker do bot ainda não foi inicializado.");
  if (!ALLOWED_METHODS.has(message.method)) throw new Error(`Método não permitido no worker: ${message.method}`);
  const method = (bot as any)[message.method];
  if (typeof method !== "function") throw new Error(`Método do bot não encontrado: ${message.method}`);

  const readOnly = message.method === "getAnalysisPreview";
  if (readOnly) {
    const deadline = Date.now() + 5_000;
    while (bot.isCriticalDispatchActive()) {
      if (shuttingDown || Date.now() >= deadline) throw new Error("Envio em andamento. Aguarde para abrir a foto.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const result = await method.apply(bot, message.args || []);
  const snapshot = readOnly || bot.isCriticalDispatchActive() ? undefined : bot.getSnapshot();
  if (snapshot && snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
    reportedCritical = false;
  }
  send({ type: "response", id: message.id, result, snapshot });
  if (!snapshot && !readOnly) scheduleSnapshot();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  for (const [id, pending] of pendingDispatchGates) {
    pendingDispatchGates.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error("O bot foi encerrado antes de concluir o envio."));
  }
  await bot?.stop().catch(() => undefined);
  shutdownIsolatedOcrWorker();
  process.disconnect?.();
  process.exit(0);
}

process.on("message", (message: BotWorkerIncomingMessage) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    void initialize(message).catch((error) => {
      console.error("Falha ao inicializar worker do bot:", error);
      process.exit(1);
    });
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  if (message.type === "dispatch-gate-response") {
    const pending = pendingDispatchGates.get(message.id);
    if (!pending) return;
    pendingDispatchGates.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error || !message.token) pending.reject(new Error(message.error || "Não foi possível concluir o envio neste ciclo."));
    else pending.resolve({ token: message.token, waitedMs: Number(message.waitedMs || 0) });
    return;
  }
  if (message.type === "call") {
    if (message.method === "getAnalysisPreview") {
      void handleCall(message).catch((error) => send({ type: "response", id: message.id, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    callQueue = callQueue
      .then(() => handleCall(message))
      .catch((error) => {
        send({
          type: "response",
          id: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }
});

process.on("disconnect", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
