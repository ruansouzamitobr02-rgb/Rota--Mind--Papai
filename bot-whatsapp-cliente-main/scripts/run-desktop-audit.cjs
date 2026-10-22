const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-desktop-audit-"));
const env = { ...process.env, DESKTOP_AUDIT_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const auditScript = process.argv[2] === "audit-web-resume.cjs" ? "audit-web-resume.cjs" : "audit-desktop.cjs";
const child = spawn(require("electron"), [path.join(__dirname, auditScript)], { env, stdio: "inherit", windowsHide: true });
const deadline = setTimeout(() => { console.error("Desktop audit timed out"); child.kill(); }, 45_000);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => {
  clearTimeout(deadline);
  process.exitCode = code ?? 1;
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("bot-desktop-audit-")) throw new Error("Invalid test directory");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
