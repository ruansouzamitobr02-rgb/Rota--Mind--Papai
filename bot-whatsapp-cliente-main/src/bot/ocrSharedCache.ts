import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { RouteOcrResult } from "./ocr";

export type SharedOcrOptions = {
  maxReadings?: number;
  fastFirst?: boolean;
  preferCageCrop?: boolean;
};

const CACHE_VERSION = "route-ocr-dark-filter-table-2026-11-13-v4";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 250;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_AFTER_MS = 150_000;
const POLL_INTERVAL_MS = 50;

type CacheRecord = {
  version: string;
  createdAt: number;
  result: RouteOcrResult;
};

type CacheLockRecord = {
  pid: number;
  token: string;
  createdAt: number;
};

/**
 * Compartilha o OCR entre processos pelo conteudo da imagem. A trava por chave
 * implementa single-flight: para a mesma foto e opcoes, apenas um processo
 * executa o Tesseract e os demais recebem exatamente o resultado gravado.
 */
export async function getOrCreateSharedOcrResult(
  imagePath: string,
  options: SharedOcrOptions,
  analyze: () => Promise<RouteOcrResult>,
  env = process.env
) {
  if (env.OCR_SHARED_CACHE === "false") return analyze();

  const cacheDir = path.join(path.resolve(env.DATA_DIR || process.cwd()), "ocr-result-cache");
  const ttlMs = parsePositiveInteger(env.OCR_SHARED_CACHE_TTL_MS, DEFAULT_TTL_MS);
  let key: string;
  try {
    key = await createCacheKey(imagePath, options);
    await fs.promises.mkdir(cacheDir, { recursive: true });
  } catch {
    // Cache e uma otimizacao: falha de disco nunca pode impedir o OCR normal.
    return analyze();
  }
  const resultPath = path.join(cacheDir, `${key}.json`);
  const firstHit = await readCachedResult(resultPath, ttlMs);
  if (firstHit) return firstHit;

  let release: () => Promise<void>;
  try {
    release = await acquireKeyLock(path.join(cacheDir, `${key}.lock`));
  } catch {
    return analyze();
  }
  try {
    // Outro processo pode ter concluido enquanto este aguardava a trava.
    const secondHit = await readCachedResult(resultPath, ttlMs);
    if (secondHit) return secondHit;

    const result = await analyze();
    if (!isRouteOcrResult(result)) return result;
    await writeCacheRecord(resultPath, {
      version: CACHE_VERSION,
      createdAt: Date.now(),
      result
    }).catch(() => undefined);
    void cleanupCache(cacheDir, ttlMs, parsePositiveInteger(env.OCR_SHARED_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES));
    return result;
  } finally {
    await release();
  }
}

export async function createSharedOcrCacheKey(imagePath: string, options: SharedOcrOptions = {}) {
  return createCacheKey(imagePath, options);
}

async function createCacheKey(imagePath: string, options: SharedOcrOptions) {
  const imageHash = await hashFile(imagePath);
  const optionKey = JSON.stringify({
    maxReadings: options.maxReadings ?? null,
    fastFirst: options.fastFirst === true,
    preferCageCrop: options.preferCageCrop === true
  });
  return crypto.createHash("sha256")
    .update(CACHE_VERSION)
    .update("\0")
    .update(optionKey)
    .update("\0")
    .update(imageHash)
    .digest("hex");
}

function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readCachedResult(resultPath: string, ttlMs: number) {
  try {
    const record = JSON.parse(await fs.promises.readFile(resultPath, "utf8")) as CacheRecord;
    if (record.version !== CACHE_VERSION || !Number.isFinite(record.createdAt)) return undefined;
    if (Date.now() - record.createdAt > ttlMs) {
      await fs.promises.unlink(resultPath).catch(() => undefined);
      return undefined;
    }
    return isRouteOcrResult(record.result) ? record.result : undefined;
  } catch (error: any) {
    if (error?.code !== "ENOENT") await fs.promises.unlink(resultPath).catch(() => undefined);
    return undefined;
  }
}

function isRouteOcrResult(value: any): value is RouteOcrResult {
  if (!value || typeof value !== "object") return false;
  if (typeof value.text !== "string" || typeof value.source !== "string" || !Array.isArray(value.lines)) return false;
  return value.variants === undefined || (Array.isArray(value.variants) && value.variants.every(isRouteOcrResult));
}

async function writeCacheRecord(resultPath: string, record: CacheRecord) {
  const temporaryPath = `${resultPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(record), "utf8");
    await fs.promises.rename(temporaryPath, resultPath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

async function acquireKeyLock(lockPath: string) {
  const token = crypto.randomUUID();
  const startedAt = Date.now();

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      const record: CacheLockRecord = { pid: process.pid, token, createdAt: Date.now() };
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.unlink(lockPath).catch(() => undefined);
        throw error;
      }

      let released = false;
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.promises.utimes(lockPath, now, now).catch(() => undefined);
      }, 5_000);
      heartbeat.unref?.();

      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        await unlinkIfOwned(lockPath, token);
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await isAbandonedLock(lockPath)) await fs.promises.unlink(lockPath).catch(() => undefined);
      else await delay(POLL_INTERVAL_MS);
    }
  }

  throw new Error("A imagem repetida excedeu 120 segundos na fila compartilhada.");
}

async function unlinkIfOwned(lockPath: string, token: string) {
  try {
    const record = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as CacheLockRecord;
    if (record.token === token) await fs.promises.unlink(lockPath);
  } catch {
    // A trava ja foi removida ou substituida.
  }
}

async function isAbandonedLock(lockPath: string) {
  try {
    const [contents, stat] = await Promise.all([
      fs.promises.readFile(lockPath, "utf8"),
      fs.promises.stat(lockPath)
    ]);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS) return true;
    // A fresh empty file can still be an owner initializing its lock.
    let record: CacheLockRecord;
    try {
      record = JSON.parse(contents) as CacheLockRecord;
    } catch {
      return false;
    }
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || !record.token) return false;
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error: any) {
      return error?.code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function cleanupCache(cacheDir: string, ttlMs: number, maxEntries: number) {
  try {
    const names = (await fs.promises.readdir(cacheDir)).filter((name) => name.endsWith(".json"));
    const entries = await Promise.all(names.map(async (name) => {
      const filePath = path.join(cacheDir, name);
      const stat = await fs.promises.stat(filePath).catch(() => undefined);
      return stat ? { filePath, mtimeMs: stat.mtimeMs } : undefined;
    }));
    const existing = entries.filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry));
    const now = Date.now();
    for (const entry of existing.filter((item) => now - item.mtimeMs > ttlMs)) {
      await fs.promises.unlink(entry.filePath).catch(() => undefined);
    }
    const active = existing.filter((item) => now - item.mtimeMs <= ttlMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of active.slice(maxEntries)) await fs.promises.unlink(entry.filePath).catch(() => undefined);
  } catch {
    // Limpeza oportunista nunca pode impedir uma analise.
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
