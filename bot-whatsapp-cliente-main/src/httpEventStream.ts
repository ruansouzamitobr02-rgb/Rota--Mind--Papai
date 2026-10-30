import type { ServerResponse } from "http";

const waiting = new WeakMap<ServerResponse, { latest?: string }>();

/** Backpressure is normal: queue only the newest state and resume after drain. */
export function writeEventStream(response: ServerResponse, payload: string, maxWaitMs = 30_000) {
  if (response.destroyed || response.writableEnded) return;
  const pending = waiting.get(response);
  if (pending) {
    if (!payload.startsWith(":")) pending.latest = payload;
    return;
  }
  if (response.write(payload)) return;
  const state: { latest?: string } = {};
  waiting.set(response, state);
  const cleanup = () => {
    clearTimeout(deadline);
    response.off("drain", drained);
    response.off("close", closed);
    waiting.delete(response);
  };
  const drained = () => {
    const latest = state.latest;
    cleanup();
    if (latest) writeEventStream(response, latest, maxWaitMs);
  };
  const closed = () => cleanup();
  const deadline = setTimeout(() => { cleanup(); response.destroy(); }, maxWaitMs);
  deadline.unref?.();
  response.once("drain", drained);
  response.once("close", closed);
}
