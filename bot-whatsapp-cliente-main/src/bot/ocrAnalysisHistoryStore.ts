import fs from "fs";
import { readJsonFileWithBackup, writeJsonAtomicAsync } from "../storageJson";
import { OcrRouteSelectionState } from "../shared/types";

const MAX_ANALYSES = 30;

export class OcrAnalysisHistoryStore {
  private items: OcrRouteSelectionState[];
  private saveTimer?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.items = this.load();
  }

  all() {
    return this.items;
  }

  setAnalysisPreview(analysisId: string, imagePreviewUrl: string) {
    let changed = false;
    this.items = this.items.map(item => {
      if (item.analysisId !== analysisId || item.imagePreviewUrl === imagePreviewUrl) return item;
      changed = true;
      return { ...item, imagePreviewUrl };
    });
    if (changed) this.scheduleSave();
  }

  upsert(selection: OcrRouteSelectionState) {
    if (["idle", "analyzing"].includes(selection.status)) return;
    const key = selection.analysisId || selection.processedAt;
    if (!key) return;
    const snapshot = JSON.parse(JSON.stringify(selection)) as OcrRouteSelectionState;
    this.items = [snapshot, ...this.items.filter((item) => (item.analysisId || item.processedAt) !== key)].slice(0, MAX_ANALYSES);
    this.scheduleSave();
  }

  private load(): OcrRouteSelectionState[] {
    const parsed = readJsonFileWithBackup<any[]>(this.filePath, () => [], Array.isArray);
    return parsed.filter(item => item && typeof item === "object" && Array.isArray(item.options) && !["idle", "analyzing"].includes(item.status)).slice(0, MAX_ANALYSES);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const snapshot = JSON.parse(JSON.stringify(this.items)) as OcrRouteSelectionState[];
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      let previous: unknown;
      try { previous = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")); } catch { /* Keep a valid existing backup. */ }
      if (Array.isArray(previous)) await writeJsonAtomicAsync(`${this.filePath}.bak`, previous);
      await writeJsonAtomicAsync(this.filePath, snapshot);
    });
    return this.saveChain;
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => console.error("Não foi possível persistir o histórico de análises."));
    }, 100);
    this.saveTimer.unref?.();
  }
}
