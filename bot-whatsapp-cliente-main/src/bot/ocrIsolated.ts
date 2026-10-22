import { ChildProcess, fork } from "child_process";
import os from "os";
import path from "path";
import { RouteOcrResult } from "./ocr";
import { readRouteImageOcrCoordinated } from "./ocrCoordinator";

type OcrOptions = { maxReadings?: number; fastFirst?: boolean; preferCageCrop?: boolean };
type PendingRequest = {
  resolve: (result: RouteOcrResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  worker: ChildProcess;
};

const OCR_WORKER_TIMEOUT_MS = 120_000;
const RETRYABLE_WORKER_ERROR = /SIGBUS|encerrou inesperadamente|worker da IA falhou|EPIPE/i;
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
    activeWorker.send?.({ type: "analyze", id, imagePath, options }, (error) => {
      if (!error) return;
      settleRequest(id, undefined, error.message);
    });
  });
}

export function warmupIsolatedOcrWorker() {
  if (!shouldUseIsolatedOcr() || warmupRequested) return;
  const activeWorker = getWorker();
  warmupRequested = true;
  activeWorker.send?.({ type: "warmup" }, (error) => {
    if (error) warmupRequested = false;
  });
}

export function shutdownIsolatedOcrWorker() {
  if (!worker) return;
  const current = worker;
  worker = undefined;
  warmupRequested = false;
  current.removeAllListeners();
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
  // OCR consome CPU intensamente. Em contenÃ§Ã£o, mantenha o socket do bot
  // O isolamento protege o socket; prioridade normal evita limitar o Tesseract.
  if (worker.pid) {
    try {
      os.setPriority(worker.pid, 0);
    } catch {
      // Alguns ambientes nÃ£o permitem alterar nice; o isolamento ainda vale.
    }
  }
  const activeWorker = worker;
  worker.on("message", (message: any) => {
    if (!message || message.type !== "result" || typeof message.id !== "string") return;
    settleRequest(message.id, message.result, message.error);
  });
  worker.on("error", (error) => {
    recycleWorker(activeWorker, `Worker da IA falhou: ${error.message}`);
  });
  worker.on("exit", (code, signal) => {
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
