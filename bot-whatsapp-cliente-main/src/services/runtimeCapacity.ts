import fs from "fs";
import os from "os";

type CapacityProbe = { cpuCount: number; cpuMax?: string; quota?: string; period?: string; memoryBytes: number; memoryMax?: string };

/** Host affinity alone can report CPUs which the Render container cannot use. */
export function resolveRuntimeCapacity(probe: CapacityProbe) {
  let cpuLimit = Math.max(1, probe.cpuCount || 1);
  const [v2Quota, v2Period] = String(probe.cpuMax || "").trim().split(/\s+/).map(Number);
  const quota = Number(probe.quota), period = Number(probe.period);
  for (const [limit, interval] of [[v2Quota, v2Period], [quota, period]]) {
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(interval) && interval > 0) cpuLimit = Math.min(cpuLimit, limit / interval);
  }
  const memoryMax = Number(probe.memoryMax);
  const memoryBytes = memoryMax > 0 && Number.isFinite(memoryMax) ? Math.min(probe.memoryBytes, memoryMax) : probe.memoryBytes;
  return { cpuLimit, cpuSlots: Math.max(1, Math.floor(cpuLimit)), memoryMb: Math.max(1, Math.floor(memoryBytes / 1024 / 1024)) };
}

function read(file: string) { try { return fs.readFileSync(file, "utf8").trim(); } catch { return undefined; } }

const capacity = resolveRuntimeCapacity({
  cpuCount: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  cpuMax: read("/sys/fs/cgroup/cpu.max"),
  quota: read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") || read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us"),
  period: read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") || read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us"),
  memoryBytes: os.totalmem(),
  memoryMax: read("/sys/fs/cgroup/memory.max") || read("/sys/fs/cgroup/memory/memory.limit_in_bytes")
});

export function getOcrRuntimeBudget(env: NodeJS.ProcessEnv = process.env, available = capacity) {
  const requested = (value: string | undefined, fallback: number) => /^\d+$/.test(value || "") && Number(value) > 0 ? Number(value) : fallback;
  const cpuSlots = Math.min(32, available.cpuSlots);
  // Each image may invoke several native readers. A second, shared CPU pool
  // bounds those readers across ALL client processes, rather than multiplying
  // 8 images × 4 variants × Tesseract's own OpenMP threads.
  const memorySlots = Math.max(1, Math.floor((available.memoryMb - 384) / 192));
  return {
    ...available,
    cpuSlots,
    imageConcurrency: Math.max(1, Math.min(8, cpuSlots, memorySlots, requested(env.OCR_GLOBAL_CONCURRENCY, cpuSlots))),
    variantConcurrency: Math.max(1, Math.min(5, cpuSlots, requested(env.OCR_VARIANT_CONCURRENCY, env.OCR_TURBO_MODE === "true" ? 4 : 3))),
    nativeThreads: 1
  };
}
