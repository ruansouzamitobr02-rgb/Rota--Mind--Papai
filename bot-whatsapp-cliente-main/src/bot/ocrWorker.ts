import { shutdownRouteOcrEngine, warmupRouteOcrEngine } from "./ocr";
import { readRouteImageOcrCoordinated } from "./ocrCoordinator";
import { acquireGlobalOcrLock } from "./ocrGlobalLock";
import { sendWorkerMessage } from "./workerIpc";

let analysisQueue = Promise.resolve();

process.on("message", (message: any) => {
  if (!message) return;

  if (message.type === "warmup") {
    analysisQueue = analysisQueue.catch(() => undefined).then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireGlobalOcrLock();
        await warmupRouteOcrEngine();
      } catch {
        // A análise real tentará novamente e devolverá o erro completo.
      } finally {
        await release?.().catch(error => console.error("Falha ao liberar aquecimento OCR:", error));
      }
    });
    return;
  }

  if (message.type !== "analyze" || typeof message.id !== "string") return;

  analysisQueue = analysisQueue.catch(() => undefined).then(async () => {
    try {
      const result = await readRouteImageOcrCoordinated(String(message.imagePath || ""), message.options || {});
      sendWorkerMessage(process, { type: "result", id: message.id, result });
    } catch (error) {
      sendWorkerMessage(process, {
        type: "result",
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
});

process.on("disconnect", () => {
  void shutdownRouteOcrEngine().catch(error => console.error("Falha ao encerrar OCR:", error)).finally(() => process.exit(0));
});
