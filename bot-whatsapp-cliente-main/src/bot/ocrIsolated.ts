import { ChildProcess, fork } from "child_process";
import os from "os";
import path from "path";
import { RouteOcrResult } from "./ocr";
import { readRouteImageOcrCoordinated } from "./ocrCoordinator";
import { sendWorkerMessage } from "./workerIpc";

type OcrOptions = { maxReadings?: number; fastFirst?: boolean; preferCageCrop?: boolean };
type PendingRequest = {
  resolve: (result: RouteOcrResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  worker: ChildProcess;
};

const OCR_WORKER_TIMEOUT_MS = 120_000;
const RETRYABLE_WORKER_ERROR = /SIGBUS|encerrou inesperadamente|worker da IA falhou|EPIPE|canal.*desconectado|channel closed/i;
const pendingRequests = new Map<string, PendingRequest>();
let worker: ChildProcess | undefined;
let requestSequence = 0;
let warmupRequested = false;

export function shouldUseIsolatedOcr(env = process.env) {
  if (env.OCR_ISOLATED_PROCESS === "false") return false;
  return env.OCR_ISOLATED_PROCESS === "true" || Boolean(env.RENDER);
}

export async function readRouteImageOcrWithoutBlockingSocket(imagePath: string, options: OcrOptions = {}) {
  if (!shouldUseIsolatedOcr()) return readRouteImageOcrCoordinated(imagePath, options);

  try {
    return await requestIsolatedOcr(imagePath, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!RETRYABLE_WORKER_ERROR.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return requestIsolatedOcr(imagePath, options);
  }
}

function requestIsolatedOcr(imagePath: string, options: OcrOptions) {
  const activeWorker = getWorker();
  const id = `${process.pid}-${Date.now()}-${++requestSequence}`;
  return new Promise<RouteOcrResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      recycleWorker(activeWorker, `Worker da IA excedeu ${Math.round(OCR_WORKER_TIMEOUT_MS / 1000)} segundos.`);
    }, OCR_WORKER_TIMEOUT_MS);
    timer.unref?.();
    pendingRequests.set(id, { resolve, reject, timer, worker: activeWorker });
    sendWorkerMessage(activeWorker, { type: "analyze", id, imagePath, options }, error =>
      recycleWorker(activeWorker, `Worker da IA falhou: ${error.message}`));
  });
}

export function warmupIsolatedOcrWorker() {
  if (!shouldUseIsolatedOcr() || warmupRequested) return;
  const activeWorker = getWorker();
  warmupRequested = true;
  sendWorkerMessage(activeWorker, { type: "warmup" }, error => recycleWorker(activeWorker, `Worker da IA falhou: ${error.message}`));
}

export function shutdownIsolatedOcrWorker() {
  if (!worker) return;
  const current = worker;
  worker = undefined;
  warmupRequested = false;
  current.removeAllListeners();
  current.on("error", () => undefined);
  current.kill();
  rejectAllPending("Worker da IA encerrado.");
}

function getWorker() {
  if (worker?.connected) return worker;

  if (worker) recycleWorker(worker);
  const workerPath = path.join(__dirname, "ocrWorker.js");
  worker = fork(workerPath, [], {
    env: { ...process.env, OCR_ISOLATED_PROCESS: "false", OCR_WORKER_PROCESS: "true" },
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  // Background CPU work yields to the WhatsApp socket during contention.
  if (worker.pid) {
    try {
      // Use idle CPUs fully; give socket events priority during contention.
      os.setPriority(worker.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Alguns ambientes nÃ£o permitem alterar nice; o isolamento ainda vale.
    }
  }
  const activeWorker = worker;
  worker.on("message", (message: any) => {
    if (worker !== activeWorker) return;
    if (!message || message.type !== "result" || typeof message.id !== "string") return;
    settleRequest(message.id, message.result, message.error);
  });
  worker.on("error", (error) => {
    recycleWorker(activeWorker, `Worker da IA falhou: ${error.message}`);
  });
  worker.on("disconnect", () => {
    if (worker === activeWorker) recycleWorker(activeWorker, "Canal do worker da IA desconectado.");
  });
  worker.on("exit", (code, signal) => {
    if (worker !== activeWorker) return;
    worker = undefined;
    warmupRequested = false;
    rejectAllPending(`Worker da IA encerrou inesperadamente (${code ?? signal ?? "sem código"}).`);
  });
  return worker;
}

function settleRequest(id: string, result?: RouteOcrResult, error?: string) {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  clearTimeout(pending.timer);
  if (error) pending.reject(new Error(error));
  else if (result) pending.resolve(result);
  else pending.reject(new Error("Worker da IA respondeu sem resultado."));
}

function rejectAllPending(message: string) {
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
}

function recycleWorker(current = worker, message = "Worker da IA falhou e será reiniciado.") {
  if (!current) return;
  if (worker === current) {
    worker = undefined;
    warmupRequested = false;
  }
  current.removeAllListeners();
  current.on("error", () => undefined); // A dying child's late IPC error is already reported above.
  current.kill();
  for (const [id, pending] of pendingRequests) {
    if (pending.worker !== current) continue;
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
}
