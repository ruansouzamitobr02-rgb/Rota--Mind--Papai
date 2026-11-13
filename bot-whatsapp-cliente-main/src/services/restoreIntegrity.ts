import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getRouteDecisionStatus } from "../shared/routeLifecycle";
import { RouteDispatch } from "../shared/types";

export type RestoreSummary = { files: number; clients: number; routes: number; validatedRoutes: number };
export type RestoreManifest = { files: { name: string; size: number; sha256: string }[]; summary: RestoreSummary };

// Read in bounded chunks: a backup may include large WhatsApp databases/photos.
function fileDigest(filePath: string) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let size: number;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}

export function inspectRestoreSnapshot(root: string): RestoreManifest {
  const files: RestoreManifest["files"] = [];
  const summary: RestoreSummary = { files: 0, clients: 0, routes: 0, validatedRoutes: 0 };
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".cloud-restore-")) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("O backup contém um link não permitido.");
      if (entry.isDirectory()) { visit(fullPath); continue; }
      if (!entry.isFile()) throw new Error("O backup contém um arquivo não permitido.");
      if (entry.name.endsWith(".json")) {
        let data: unknown;
        try { data = JSON.parse(fs.readFileSync(fullPath, "utf8")); }
        catch { throw new Error(`Arquivo ${entry.name} inválido no backup. Os dados atuais foram preservados.`); }
        if (entry.name === "panel_users.json") {
          if (!Array.isArray(data) || data.some((user) => !user || typeof user.email !== "string" || typeof user.password !== "string")) {
            throw new Error("A lista de contas do backup é inválida. Os dados atuais foram preservados.");
          }
          summary.clients += data.filter((user) => user.role === "client").length;
        }
        if (entry.name === "route_history.json") {
          if (!Array.isArray(data) || data.some((route) => !route || typeof route !== "object")) throw new Error("O histórico de rotas do backup é inválido.");
          summary.routes += data.length;
          summary.validatedRoutes += data.filter((route) => getRouteDecisionStatus(route as RouteDispatch) === "validated").length;
        }
      }
      files.push({ name: path.relative(root, fullPath).replace(/\\/g, "/"), size: fs.statSync(fullPath).size, sha256: fileDigest(fullPath) });
      summary.files++;
    }
  }
  visit(root);
  if (!files.length) throw new Error("O backup não contém arquivos para restaurar.");
  return { files, summary };
}

export function verifyRestoreManifest(root: string, manifest: RestoreManifest) {
  if (!Array.isArray(manifest?.files) || !manifest.files.length || !manifest.summary) throw new Error("Verificação da restauração ausente.");
  for (const file of manifest.files) {
    const resolved = path.resolve(root, file.name);
    if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`) || file.name.split(/[\\/]/).includes("..")) throw new Error("Caminho inválido na verificação da restauração.");
    if (fs.statSync(resolved).size !== file.size || fileDigest(resolved) !== file.sha256) {
      throw new Error(`Os dados restaurados de ${file.name} não foram preservados após reiniciar.`);
    }
  }
}

export type RestoreStorageStatus = { ready: boolean; dataDir: string; message: string };

export function getRestoreStorageStatus(dataDir: string, options = {
  render: Boolean(process.env.RENDER), platform: process.platform as string,
  mountInfo: process.platform === "linux" ? (() => { try { return fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return ""; } })() : ""
}): RestoreStorageStatus {
  const resolved = path.resolve(dataDir);
  if (!options.render) return { ready: true, dataDir: resolved, message: `Dados salvos em ${resolved}.` };
  // A writable directory in the container is not evidence of a persistent disk.
  const mounts = options.mountInfo.split("\n").map((line) => {
    const [fields, filesystem] = line.split(" - ");
    const mount = fields?.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return { mount, type: filesystem?.split(" ")[0] };
  }).filter((item) => item.mount && (resolved === item.mount || resolved.startsWith(`${item.mount}/`)))
    .sort((a, b) => b.mount.length - a.mount.length);
  const mount = mounts[0];
  const ready = options.platform === "linux" && Boolean(mount && mount.mount !== "/" && mount.type && !["overlay", "tmpfs", "ramfs", "aufs"].includes(mount.type));
  return { ready, dataDir: resolved, message: ready
    ? `Disco persistente detectado em ${mount.mount}.`
    : `O Render não tem um disco persistente detectável para ${resolved}. Em Render → Disks, monte um disco nesse caminho e mantenha DATA_DIR apontando para ele antes de restaurar.` };
}
