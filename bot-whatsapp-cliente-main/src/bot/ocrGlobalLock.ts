import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getOcrRuntimeBudget } from "../services/runtimeCapacity";
import { waitForOcrPoolSignal } from "./ocrPoolSignal";

const POLL_INTERVAL_MS = 75;
const LOCK_TIMEOUT_MS = 120_000;
const STALE_AFTER_MS = 120_000;

type LockRecord = { pid: number; token: string; createdAt: number };

export async function acquireGlobalOcrLock(env = process.env) {
  return acquirePoolSlot("ocr-global", getOcrRuntimeBudget(env).imageConcurrency, env);
}

export async function acquireGlobalOcrCpu(env = process.env) {
  return acquirePoolSlot("ocr-cpu", getOcrRuntimeBudget(env).cpuSlots, env);
}

async function acquirePoolSlot(prefix: string, concurrency: number, env: NodeJS.ProcessEnv) {
  const dataDir = path.resolve(env.DATA_DIR || process.cwd());
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  fs.mkdirSync(dataDir, { recursive: true });

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    for (let slot = 0; slot < concurrency; slot += 1) {
      const lockPath = path.join(dataDir, `${prefix}-${slot}.lock`);
      const release = await tryAcquireSlot(lockPath, token);
      if (release) return release;
    }
    await waitForOcrPoolSignal(dataDir, name => name.startsWith(`${prefix}-`) && name.endsWith(".lock"), POLL_INTERVAL_MS);
  }

  throw new Error("A fila global da IA excedeu 120 segundos.");
}

async function tryAcquireSlot(lockPath: string, token: string): Promise<(() => Promise<void>) | undefined> {
  try {
    const handle = await fs.promises.open(lockPath, "wx");
    const record: LockRecord = { pid: process.pid, token, createdAt: Date.now() };
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
    if (await isAbandonedLock(lockPath)) {
      await fs.promises.unlink(lockPath).catch((unlinkError: any) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
    return undefined;
  }
}

async function unlinkIfOwned(lockPath: string, token: string) {
  try {
    const record = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as LockRecord;
    if (record.token === token) await fs.promises.unlink(lockPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") return;
  }
}

async function isAbandonedLock(lockPath: string) {
  try {
    const [contents, stat] = await Promise.all([
      fs.promises.readFile(lockPath, "utf8"),
      fs.promises.stat(lockPath)
    ]);
    if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) return true;
    // Another process may have opened the file but not written its record yet.
    // Only reclaim incomplete records after the stale interval has elapsed.
    let record: LockRecord;
    try {
      record = JSON.parse(contents) as LockRecord;
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
