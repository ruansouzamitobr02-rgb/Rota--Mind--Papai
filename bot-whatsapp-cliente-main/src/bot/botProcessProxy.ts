import { ChildProcess, fork } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { DEFAULT_CONFIG } from "./config";
import type { BotServiceOptions } from "./connection";
import type { BotWorkerOutgoingMessage } from "./botProcessProtocol";
import type { BotSnapshot, LeaderContact, RouteDispatch } from "../shared/types";

type PendingCall = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RecoveryIntent = {
  running: boolean;
  monitoringEnabled: boolean;
  monitoringMode?: "target" | "test";
  targetDispatchMode?: "manual" | "ocr";
  nuclearMode?: boolean;
};

const CALL_TIMEOUT_MS = 120_000;
const RESTART_DELAY_MS = 1_000;

function initialSnapshot(): BotSnapshot {
  return {
    status: "disconnected",
    groupState: "unknown",
    qrCode: "",
    config: { ...DEFAULT_CONFIG },
    groups: [],
    readinessChecks: [],
    logs: [],
    monitoringEnabled: false,
    warmupCompleted: false,
    warmupMessagesSent: 0,
    warmupRequiredMessages: DEFAULT_CONFIG.testMessageCount,
    testStatus: {
      active: false,
      lastSentCount: 0,
      lastFailedCount: 0,
      configuredMessageCount: DEFAULT_CONFIG.testMessageCount,
      intervalMs: 0
    },
    performanceMetrics: {
      lastDispatchLatencyMs: 0,
      averageDispatchLatencyMs: 0,
      lastDispatchDurationMs: 0,
      averageMessageSendMs: 0,
      dispatchCount: 0,
      sentMessages: 0,
      failedMessages: 0,
      activeQueue: 0
    },
    routeDispatches: [],
    statusEvents: [],
    ocrRouteSelection: { status: "idle", options: [] }
  };
}

export class BotProcessProxy extends EventEmitter {
  private child?: ChildProcess;
  private snapshot: BotSnapshot = initialSnapshot();
  private pending = new Map<string, PendingCall>();
  private sequence = 0;
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private restartTimer?: NodeJS.Timeout;
  private intentionalShutdown = false;
  private critical = false;
  private recoveryIntent?: RecoveryIntent;
  private restoring = false;
  private restartCount = 0;

  constructor(private readonly options: BotServiceOptions) {
    super();
    this.spawn();
  }

  getSnapshot() {
    return this.snapshot;
  }

  getAnalysisPreview(id: string): Promise<string | undefined> { return this.call("getAnalysisPreview", id); }

  getRoutes(): RouteDispatch[] {
    return this.snapshot.routeDispatches || [];
  }

  hasPendingClientIncident() {
    return this.getRoutes().some((route) => route.clientIncident?.required && !route.clientIncident.answeredAt);
  }

  isCriticalDispatchActive() {
    return this.critical;
  }

  getWorkerPid() {
    return this.child?.pid;
  }

  ready() {
    return this.readyPromise || Promise.resolve();
  }

  async shutdown() {
    this.intentionalShutdown = true;
    this.rejectReady?.(new Error("Worker do bot encerrado."));
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    this.rejectPending("Worker do bot encerrado.");
    if (!child) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 5_000);
      timeout.unref?.();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.send?.({ type: "shutdown" }, () => undefined);
    });
  }

  start() { this.recoveryIntent = undefined; return this.call("start"); }
  stop() { this.recoveryIntent = { running: false, monitoringEnabled: false }; return this.call("stop"); }
  restart() { return this.call("restart"); }
  clearSession() { return this.call("clearSession"); }
  refreshQrCode() { return this.call("refreshQrCode"); }
  factoryReset() { return this.call("factoryReset"); }
  clearLogs(silent = false) { return this.call("clearLogs", silent); }
  clearRouteHistory(silent = false) { return this.call("clearRouteHistory", silent); }
  refreshGroups() { return this.call("refreshGroups"); }
  enableMonitoring() { this.recoveryIntent = undefined; return this.call("enableMonitoring"); }
  enableImageMonitoring() { this.recoveryIntent = undefined; return this.call("enableImageMonitoring"); }
  enableNuclearMonitoring() { this.recoveryIntent = undefined; return this.call("enableNuclearMonitoring"); }
  enableTestMonitoring() { this.recoveryIntent = undefined; return this.call("enableTestMonitoring"); }
  disableMonitoring() { this.recoveryIntent = { running: this.snapshot.status !== "disconnected", monitoringEnabled: false }; return this.call("disableMonitoring"); }
  simulateOpening() { return this.call("simulateOpening"); }
  manualDispatch() { return this.call("manualDispatch"); }
  simulateTargetDispatchOnTestGroup() { return this.call("simulateTargetDispatchOnTestGroup"); }
  runLatencyProbeOnTestGroup() { return this.call("runLatencyProbeOnTestGroup"); }
  warmupConnection(message?: string) { return this.call("warmupConnection", message); }
  saveGroup(group: string, groupId?: string, groupName?: string) { return this.call("saveGroup", group, groupId, groupName); }
  saveTestGroup(group: string, groupId?: string, groupName?: string) { return this.call("saveTestGroup", group, groupId, groupName); }
  setMessageCodes(codes: string[]) { return this.call("setMessageCodes", codes); }
  setMessageSettings(...args: any[]) { return this.call("setMessageSettings", ...args); }
  setWarmupMessageSettings(...args: any[]) { return this.call("setWarmupMessageSettings", ...args); }
  setDispatchPriorityLevel(level: number) { return this.call("setDispatchPriorityLevel", level); }
  setDispatchPriorityDelayMs(delayMs: number) { return this.call("setDispatchPriorityDelayMs", delayMs); }
  resolveDispatchGate(id: string, result: { token?: string; waitedMs?: number; error?: string }) {
    const child = this.child;
    if (!child?.connected) return false;
    child.send?.({ type: "dispatch-gate-response", id, ...result });
    return true;
  }
  saveRoutePreset(name: string, routes: { cidade: string; bairro: string }[]) { return this.call("saveRoutePreset", name, routes); }
  deleteRoutePreset(id: string) { return this.call("deleteRoutePreset", id); }
  setGeneralSettings(settings: any) { return this.call("setGeneralSettings", settings); }
  confirmOcrRouteSelection(optionIds: string[]) { return this.call("confirmOcrRouteSelection", optionIds); }
  submitClientIncident(routeId: string, valid: boolean, reason: string) { return this.call("submitClientIncident", routeId, valid, reason); }
  snoozeClientIncident(routeId: string) { return this.call("snoozeClientIncident", routeId); }
  validateRoute(routeId: string, validatedBy: string) { return this.call("validateRoute", routeId, validatedBy); }
  rejectRoute(routeId: string, rejectedBy: string, reason?: string) { return this.call("rejectRoute", routeId, rejectedBy, reason); }
  setLeaderContacts(contacts: LeaderContact[]) { return this.call("setLeaderContacts", contacts); }
  locateRomaneioInGroup() { return this.call("locateRomaneioInGroup"); }
  confirmRomaneioCandidate(candidateId: string) { return this.call("confirmRomaneioCandidate", candidateId); }

  private spawn() {
    if (this.intentionalShutdown) return;
    const workerPath = path.join(__dirname, "botWorker.js");
    const child = fork(workerPath, [], {
      env: {
        ...process.env,
        BOT_CLIENT_WORKER: "true",
        OCR_ISOLATED_PROCESS: process.env.OCR_ISOLATED_PROCESS || "true"
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    this.child = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // O supervisor pode criar workers antes de existir uma requisição aguardando
    // ready(). Mantenha a rejeição observada para uma falha de spawn não derrubar
    // o processo HTTP por unhandled rejection.
    void this.readyPromise.catch(() => undefined);

    child.on("message", (message: BotWorkerOutgoingMessage) => { if (this.child === child) this.handleMessage(message); });
    child.on("error", (error) => { if (this.child === child) this.handleExit(error); });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.handleExit(new Error(`Worker encerrou (${code ?? signal ?? "sem código"}).`));
    });
    child.send?.({ type: "init", options: this.options });
  }

  private handleMessage(message: BotWorkerOutgoingMessage) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      this.updateSnapshot(message.snapshot);
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      void this.restoreAfterCrash();
      return;
    }
    if (message.type === "snapshot") {
      this.critical = false;
      this.updateSnapshot(message.snapshot);
      void this.restoreMonitoringIfConnected().catch(() => console.error("Não foi possível restaurar o monitoramento do bot."));
      return;
    }
    if (message.type === "snapshot-dirty") {
      this.critical = message.critical;
      return;
    }
    if (message.type === "image-analysis") {
      this.emit("image-analysis", message.analysis);
      return;
    }
    if (message.type === "route-auto-validated") {
      this.emit("route-auto-validated", message);
      return;
    }
    if (message.type === "dispatch-gate-request") {
      this.emit("dispatch-gate-request", message);
      return;
    }
    if (message.type === "dispatch-gate-relay") {
      this.emit("dispatch-gate-relay", message);
      return;
    }
    if (message.type === "dispatch-gate-failure") {
      this.emit("dispatch-gate-failure", message);
      return;
    }
    if (message.type === "dispatch-race-event") {
      this.emit("dispatch-race-event", message);
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.snapshot) this.updateSnapshot(message.snapshot);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }

  private updateSnapshot(snapshot: BotSnapshot) {
    this.snapshot = {
      ...snapshot,
      performanceMetrics: snapshot.performanceMetrics
        ? {
            ...snapshot.performanceMetrics,
            workerProcessId: this.child?.pid,
            workerRestartCount: this.restartCount
          }
        : snapshot.performanceMetrics
    };
    this.critical = false;
    this.emit("snapshot");
  }

  private async call(method: string, ...args: any[]) {
    await this.ready();
    const child = this.child;
    if (!child?.connected) throw new Error("Worker do bot está reiniciando. Tente novamente em alguns segundos.");
    const id = `${process.pid}-${Date.now()}-${++this.sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Comando ${method} excedeu ${Math.round(CALL_TIMEOUT_MS / 1000)} segundos.`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.send?.({ type: "call", id, method, args }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private handleExit(error: Error) {
    if (this.intentionalShutdown || this.restartTimer) return;
    this.emit("worker-exit", error);
    this.child = undefined;
    this.restoring = false;
    this.recoveryIntent ??= {
      running: ["connected", "connecting", "waiting_qr", "reconnecting"].includes(this.snapshot.status),
      monitoringEnabled: Boolean(this.snapshot.monitoringEnabled),
      monitoringMode: this.snapshot.monitoringMode,
      targetDispatchMode: this.snapshot.config.targetDispatchMode,
      nuclearMode: this.snapshot.config.nuclearMode
    };
    this.restartCount += 1;
    this.snapshot = {
      ...this.snapshot,
      status: "reconnecting",
      error: "Processo isolado reiniciando automaticamente."
    };
    this.critical = false;
    this.rejectReady?.(error);
    this.rejectPending(error.message);
    this.emit("snapshot");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawn();
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  private rejectPending(message: string) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
  }

  private async restoreAfterCrash() {
    if (!this.recoveryIntent?.running || this.restoring) return;
    this.restoring = true;
    try {
      await this.call("start");
      if (!this.recoveryIntent?.monitoringEnabled) {
        this.recoveryIntent = undefined;
        this.restoring = false;
      }
    } catch {
      this.restoring = false;
    }
  }

  private async restoreMonitoringIfConnected() {
    const intent = this.recoveryIntent;
    if (!intent?.monitoringEnabled || this.snapshot.status !== "connected") return;
    this.recoveryIntent = undefined;
    try {
      if (intent.monitoringMode === "test") await this.call("enableTestMonitoring");
      else if (intent.targetDispatchMode === "ocr") await this.call("enableImageMonitoring");
      else if (intent.nuclearMode) await this.call("enableNuclearMonitoring");
      else await this.call("enableMonitoring");
    } catch (error) {
      this.recoveryIntent = intent;
      throw error;
    } finally {
      this.restoring = false;
    }
  }
}
