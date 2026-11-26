import fs from "fs";
import path from "path";

/** Wake contenders when an owner releases a slot; polling remains the fallback. */
export function waitForOcrPoolSignal(directory: string, matches: (filename: string) => boolean, fallbackMs: number) {
  // libuv's Windows directory watcher can abort the process on junction/short
  // temp paths. Windows keeps the bounded polling path; Render uses inotify.
  if (process.platform === "win32") return new Promise<void>(resolve => setTimeout(resolve, fallbackMs));
  return new Promise<void>(resolve => {
    let watcher: fs.FSWatcher | undefined, done = false;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer); watcher?.close(); resolve();
    };
    const timer = setTimeout(finish, fallbackMs);
    try {
      watcher = fs.watch(directory, { persistent: false }, (event, filename) => {
        if (event === "rename" && filename !== null && matches(path.basename(String(filename)))) finish();
      });
      watcher.on("error", () => { watcher?.close(); watcher = undefined; });
    } catch { /* This filesystem may not support notifications; keep the timer. */ }
  });
}
