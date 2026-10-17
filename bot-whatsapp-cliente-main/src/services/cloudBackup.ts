import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip, createGzip } from "zlib";
import * as tar from "tar-stream";

const BACKUP_PREFIX = "rota-mind-backup-v1";
// Backups from the previous Render setup were written with an extra folder
// level in the same R2 bucket. Keep them restorable, but never write/prune there.
const RESTORE_PREFIXES = [BACKUP_PREFIX, "rota-mind-backups/rota-mind-backup-v1"] as const;
const BACKUP_MAGIC = Buffer.from("RMDBK001", "ascii");
const PORTABLE_BACKUP_MAGIC = Buffer.from("RMDBK002", "ascii");
const PORTABLE_SALT_BYTES = 16;
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;

type BackupConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  encryptionKey: Buffer;
  intervalMs: number;
  retentionDays: number;
};

export type CloudBackupStatus = {
  enabled: boolean;
  configured: boolean;
  intervalMinutes: number;
  retentionDays: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastObjectKey?: string;
  lastError?: string;
  running: boolean;
};

export type CloudBackupObject = { key: string; size: number; lastModified?: string };

export type CloudRestoreStatus = {
  phase: "idle" | "listing" | "waiting_backup" | "downloading" | "validating" | "ready" | "applying" | "completed" | "failed";
  progress?: number;
  sourceKey?: string;
  message: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
};

let status: CloudBackupStatus = {
  enabled: false,
  configured: false,
  intervalMinutes: 15,
  retentionDays: DEFAULT_RETENTION_DAYS,
  running: false
};
let activeBackup: Promise<void> | undefined;
let restoring = false;
let schedule: NodeJS.Timeout | undefined;
let client: S3Client | undefined;
let config: BackupConfig | undefined;
let dailySnapshotDate: string | undefined;
let restoreStatus: CloudRestoreStatus | undefined;

function parseEncryptionKey(value: string | undefined): Buffer | undefined {
  const normalized = String(value || "").trim();
  if (/^[a-f\d]{64}$/i.test(normalized)) return Buffer.from(normalized, "hex");
  if (/^[A-Za-z\d+/]{43}=$/.test(normalized)) {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 32) return decoded;
  }
  return undefined;
}

function loadConfig(env: NodeJS.ProcessEnv): BackupConfig | undefined {
  const endpoint = String(env.R2_ENDPOINT || "").trim();
  const bucket = String(env.R2_BUCKET || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const encryptionKey = parseEncryptionKey(env.R2_BACKUP_ENCRYPTION_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !encryptionKey) return undefined;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password) return undefined;
  const intervalMinutes = Number(env.R2_BACKUP_INTERVAL_MINUTES || 15);
  const retentionDays = Number(env.R2_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  return {
    endpoint: parsedEndpoint.toString().replace(/\/$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    encryptionKey,
    intervalMs: Number.isFinite(intervalMinutes) ? Math.max(5, Math.min(1440, intervalMinutes)) * 60_000 : DEFAULT_INTERVAL_MS,
    retentionDays: Number.isFinite(retentionDays) ? Math.max(7, Math.min(365, Math.floor(retentionDays))) : DEFAULT_RETENTION_DAYS
  };
}

function shouldSkip(relativePath: string, isDirectory: boolean) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => ["ocr-result-cache", ".git", "node_modules", "cloud-backup-temp"].includes(segment)
    || segment.startsWith(".cloud-restore-"))) return true;
  const name = segments[segments.length - 1] || "";
  if (name === ".cloud-restore-status.json" || name === ".cloud-restore-status.json.tmp") return true;
  if (/^ocr-global-.*\.lock$/i.test(name) || /\.tmp$/i.test(name)) return true;
  if (!isDirectory && /(?:^|\/)cloud-backup\.(?:tar\.gz|enc)$/i.test(relativePath)) return true;
  return false;
}

async function addDirectoryToArchive(archive: tar.Pack, root: string, stagingDir: string, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (shouldSkip(childRelative, entry.isDirectory())) continue;
    if (/(?:-wal|-shm)$/i.test(entry.name)) continue;
    const fullPath = path.join(root, childRelative);
    if (entry.isDirectory()) {
      await addDirectoryToArchive(archive, root, stagingDir, childRelative);
    } else if (entry.isFile()) {
      let archivePath = fullPath;
      let snapshotPath: string | undefined;
      if (entry.name === "auth.sqlite") {
        snapshotPath = path.join(stagingDir, `sqlite-${crypto.randomUUID()}.db`);
        const Database = require("better-sqlite3") as new (filePath: string, options?: object) => {
          backup(destination: string): Promise<void>;
          close(): void;
        };
        const database = new Database(fullPath, { readonly: true, fileMustExist: true });
        try {
          await database.backup(snapshotPath);
        } finally {
          database.close();
        }
        archivePath = snapshotPath;
      }
      try {
        const fileStat = await fs.promises.stat(archivePath);
        await new Promise<void>((resolve, reject) => {
          const packedEntry = archive.entry({
            name: childRelative.replace(/\\/g, "/"),
            size: fileStat.size,
            mode: fileStat.mode & 0o777,
            mtime: fileStat.mtime
          }, (error) => error ? reject(error) : resolve());
          const source = fs.createReadStream(archivePath);
          source.on("error", reject);
          source.pipe(packedEntry);
        });
      } finally {
        if (snapshotPath) await fs.promises.unlink(snapshotPath).catch(() => undefined);
      }
    }
  }
}

export async function createEncryptedArchive(dataDir: string, outputPath: string, encryptionKey: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const archive = tar.pack();
  const gzip = createGzip({ level: 1 });
  const header = Buffer.concat([BACKUP_MAGIC, iv]);

  output.write(header);
  const completed = pipeline(archive, gzip, cipher, output);
  try {
    await addDirectoryToArchive(archive, dataDir, path.dirname(outputPath));
    archive.finalize();
    await completed;
    await fs.promises.appendFile(outputPath, cipher.getAuthTag());
  } catch (error) {
    archive.destroy(error instanceof Error ? error : undefined);
    output.destroy();
    await fs.promises.unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

async function derivePortableKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function createPortableEncryptedArchive(dataDir: string, outputPath: string, passphrase: string) {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error("A senha do arquivo precisa ter pelo menos 12 caracteres.");
  const salt = crypto.randomBytes(PORTABLE_SALT_BYTES);
  const iv = crypto.randomBytes(12);
  const key = await derivePortableKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const archive = tar.pack();
  const gzip = createGzip({ level: 1 });
  output.write(Buffer.concat([PORTABLE_BACKUP_MAGIC, salt, iv]));
  const completed = pipeline(archive, gzip, cipher, output);
  try {
    await addDirectoryToArchive(archive, dataDir, path.dirname(outputPath));
    archive.finalize();
    await completed;
    await fs.promises.appendFile(outputPath, cipher.getAuthTag());
  } catch (error) {
    archive.destroy(error instanceof Error ? error : undefined);
    output.destroy();
    await fs.promises.unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

async function uploadBackup(filePath: string, key: string, date: string) {
  if (!client || !config) throw new Error("R2 backup is not configured.");
  const file = await fs.promises.stat(filePath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: file.size,
    ContentType: "application/vnd.rota-mind.encrypted-backup",
    Metadata: {
      format: "rota-mind-backup-v1",
      encrypted: "aes-256-gcm",
      created: date
    }
  }));
}

async function pruneOldDailyBackups() {
  if (!client || !config) return;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - config.retentionDays);
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${BACKUP_PREFIX}/daily/`,
      ContinuationToken: continuationToken
    }));
    const expired = (listed.Contents || [])
      .filter((item) => item.Key && item.LastModified && item.LastModified < cutoff)
      .map((item) => ({ Key: item.Key! }));
    if (expired.length) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: expired, Quiet: true } }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

export function getCloudBackupStatus(): CloudBackupStatus {
  return { ...status };
}

export async function listCloudBackupObjects(): Promise<CloudBackupObject[]> {
  if (!config || !client) throw new Error("Cloud backup is not configured.");
  const objects: CloudBackupObject[] = [];
  for (const prefix of RESTORE_PREFIXES) {
    let continuationToken: string | undefined;
    do {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken
      }));
      for (const item of listed.Contents || []) {
        if (!item.Key?.endsWith(".rmbak")) continue;
        objects.push({ key: item.Key, size: item.Size || 0, lastModified: item.LastModified?.toISOString() });
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  return objects.sort((left, right) => (right.lastModified || "").localeCompare(left.lastModified || ""));
}

export function getCloudRestoreStatus(dataDir: string): CloudRestoreStatus {
  if (restoreStatus) return { ...restoreStatus };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, ".cloud-restore-status.json"), "utf8")) as CloudRestoreStatus;
    if (saved && typeof saved.phase === "string" && typeof saved.message === "string") {
      restoreStatus = saved;
      return { ...saved };
    }
  } catch { /* No restore marker yet. */ }
  return { phase: "idle", message: "Nenhuma restauração executada ainda.", updatedAt: new Date().toISOString() };
}

export function setCloudRestoreStatus(dataDir: string, update: Partial<CloudRestoreStatus> & Pick<CloudRestoreStatus, "phase" | "message">) {
  const previous = restoreStatus || getCloudRestoreStatus(dataDir);
  restoreStatus = {
    ...previous,
    ...update,
    startedAt: update.startedAt || previous.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const tempPath = path.join(dataDir, ".cloud-restore-status.json.tmp");
  try {
    fs.writeFileSync(tempPath, JSON.stringify(restoreStatus), { mode: 0o600 });
    fs.renameSync(tempPath, path.join(dataDir, ".cloud-restore-status.json"));
  } catch (error) {
    console.error(`[BACKUP] Could not save restore status: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...restoreStatus };
}

export async function runCloudBackup(dataDir: string) {
  if (restoring) throw new Error("Backup pausado durante uma restauraÃ§Ã£o.");
  if (!config || !client) throw new Error("Backup na nuvem ainda não está configurado no servidor.");
  if (activeBackup) return activeBackup;
  activeBackup = (async () => {
    const attemptedAt = new Date();
    status = { ...status, running: true, lastAttemptAt: attemptedAt.toISOString(), lastError: undefined };
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rota-mind-backup-"));
    const encryptedPath = path.join(tempDir, "snapshot.rmbak");
    try {
      await createEncryptedArchive(dataDir, encryptedPath, config!.encryptionKey);
      const date = attemptedAt.toISOString();
      const latestKey = `${BACKUP_PREFIX}/latest.rmbak`;
      await uploadBackup(encryptedPath, latestKey, date);
      const day = date.slice(0, 10);
      const dailyKey = `${BACKUP_PREFIX}/daily/${day}.rmbak`;
      if (dailySnapshotDate !== day) {
        let dailyExists = false;
        try {
          await client!.send(new HeadObjectCommand({ Bucket: config!.bucket, Key: dailyKey }));
          dailyExists = true;
        } catch (error) {
          const response = error as { $metadata?: { httpStatusCode?: number }; name?: string };
          if (response.$metadata?.httpStatusCode !== 404 && response.name !== "NotFound" && response.name !== "NoSuchKey") throw error;
        }
        if (!dailyExists) await uploadBackup(encryptedPath, dailyKey, date);
        dailySnapshotDate = day;
      }
      try {
        await pruneOldDailyBackups();
      } catch (error) {
        console.error(`[BACKUP] Snapshot enviado, mas a limpeza da retenção falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      }
      status = { ...status, enabled: true, configured: true, running: true, lastSuccessAt: date, lastObjectKey: latestKey, lastError: undefined };
      console.log(`[BACKUP] Snapshot criptografado enviado ao R2: ${date}.`);
    } catch (error) {
      status = { ...status, lastError: "Falha ao criar ou enviar o snapshot para o R2." };
      console.error(`[BACKUP] Envio falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      throw error;
    } finally {
      status = { ...status, running: false };
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  try {
    await activeBackup;
  } finally {
    activeBackup = undefined;
  }
}

const RESTORE_JOURNAL = ".cloud-restore-journal.json";
const MAX_RESTORE_BYTES = 20 * 1024 * 1024 * 1024;

function safeArchivePath(root: string, name: string) {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name)) {
    throw new Error("O backup contÃ©m um caminho invÃ¡lido.");
  }
  const segments = name.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".cloud-restore-"))) {
    throw new Error("O backup contÃ©m um caminho invÃ¡lido.");
  }
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("O backup tenta sair da pasta de dados.");
  return target;
}

export async function extractEncryptedArchive(
  archivePath: string,
  destination: string,
  encryptionKey: Buffer | string,
  onProgress?: (progress: number, message: string) => void
) {
  const file = await fs.promises.open(archivePath, "r");
  try {
    const stat = await file.stat();
    if (stat.size < 36) throw new Error("O arquivo de backup estÃ¡ incompleto.");
    const tag = Buffer.alloc(16);
    await file.read(tag, 0, 16, stat.size - 16);
    const magic = Buffer.alloc(8);
    await file.read(magic, 0, 8, 0);
    const isPortable = magic.equals(PORTABLE_BACKUP_MAGIC);
    if (!isPortable && !magic.equals(BACKUP_MAGIC)) throw new Error("Formato de backup desconhecido.");
    const headerSize = isPortable ? 36 : 20;
    if (stat.size < headerSize + 16) throw new Error("O arquivo de backup estÃ¡ incompleto.");
    const header = Buffer.alloc(headerSize - 8);
    await file.read(header, 0, header.length, 8);
    let key: Buffer;
    let iv: Buffer;
    if (isPortable) {
      if (typeof encryptionKey !== "string") throw new Error("Este arquivo portÃ¡til precisa da senha escolhida na exportaÃ§Ã£o.");
      if (encryptionKey.length < 12 || encryptionKey.length > 1024) throw new Error("A senha precisa ter pelo menos 12 caracteres.");
      key = await derivePortableKey(encryptionKey, header.subarray(0, PORTABLE_SALT_BYTES));
      iv = header.subarray(PORTABLE_SALT_BYTES);
    } else {
      if (typeof encryptionKey === "string") throw new Error("Este snapshot do R2 usa a chave configurada no servidor antigo.");
      key = encryptionKey;
      iv = header.subarray(0, 12);
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const extract = tar.extract();
    let entryCount = 0;
    let expandedBytes = 0;
    let processedBytes = 0;
    let lastReportedBytes = 0;
    const encryptedPayloadBytes = Math.max(1, stat.size - headerSize - 16);
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        processedBytes += chunk.length;
        if (onProgress && (processedBytes - lastReportedBytes >= 512 * 1024 || processedBytes >= encryptedPayloadBytes)) {
          lastReportedBytes = processedBytes;
          const percent = Math.min(99, Math.floor(processedBytes / encryptedPayloadBytes * 100));
          onProgress(55 + Math.floor(percent * 0.32), `Validando e extraindo snapshot: ${percent}%`);
        }
        callback(null, chunk);
      }
    });
    extract.on("entry", (entryHeader, entry, next) => {
      try {
        const target = safeArchivePath(destination, entryHeader.name);
        if (entryHeader.type === "directory") {
          entryCount++;
          fs.mkdirSync(target, { recursive: true, mode: entryHeader.mode || 0o700 });
          entry.resume();
          next();
          return;
        }
        if (entryHeader.type !== "file" && entryHeader.type !== "contiguous-file") throw new Error("O backup contÃ©m um tipo de arquivo nÃ£o permitido.");
        const size = Number(entryHeader.size || 0);
        if (!Number.isSafeInteger(size) || size < 0 || expandedBytes + size > MAX_RESTORE_BYTES) throw new Error("O backup ultrapassa o limite de restauraÃ§Ã£o de 20 GB.");
        expandedBytes += size;
        entryCount++;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const output = fs.createWriteStream(target, { flags: "wx", mode: (entryHeader.mode || 0o600) & 0o700 });
        void pipeline(entry, output).then(() => next(), next);
      } catch (error) {
        entry.resume();
        next(error instanceof Error ? error : new Error("NÃ£o foi possÃ­vel validar o backup."));
      }
    });
    await pipeline(
      fs.createReadStream(archivePath, { start: headerSize, end: stat.size - 17 }),
      progress,
      decipher,
      createGunzip(),
      extract
    );
    if (!entryCount) throw new Error("O backup nÃ£o contÃ©m dados para restaurar.");
  } finally {
    await file.close();
  }
}

/** Downloads and fully validates latest.rmbak, extracting it to a private staging folder. */
export async function prepareCloudRestore(dataDir: string, requestedSourceKey?: string) {
  if (!config || !client) throw new Error("O backup na nuvem nÃ£o estÃ¡ configurado neste servidor.");
  if (restoring) throw new Error("JÃ¡ existe uma restauraÃ§Ã£o em andamento.");
  restoring = true;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rota-mind-restore-"));
  const archivePath = path.join(tempDir, "selected.rmbak");
  const stageDir = path.join(dataDir, `.cloud-restore-stage-${crypto.randomUUID()}`);
  try {
    setCloudRestoreStatus(dataDir, {
      phase: activeBackup ? "waiting_backup" : "listing",
      message: activeBackup ? "Aguardando o backup em andamento terminar..." : "Localizando o snapshot selecionado...",
      sourceKey: requestedSourceKey,
      progress: undefined,
      startedAt: new Date().toISOString(),
      completedAt: undefined
    });
    if (activeBackup) await activeBackup;
    const daily = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${BACKUP_PREFIX}/daily/`
    }));
    const dailySnapshot = (daily.Contents || [])
      .filter((item) => item.Key?.endsWith(".rmbak"))
      .sort((left, right) => (right.LastModified?.getTime() || 0) - (left.LastModified?.getTime() || 0))[0];
    const sourceKey = requestedSourceKey || dailySnapshot?.Key || `${BACKUP_PREFIX}/latest.rmbak`;
    const available = await listCloudBackupObjects();
    const allowedPrefix = RESTORE_PREFIXES.some((prefix) => sourceKey.startsWith(`${prefix}/`));
    if (!allowedPrefix || !sourceKey.endsWith(".rmbak") || !available.some((item) => item.key === sourceKey)) {
      throw new Error("Esse arquivo não está disponível no bucket de backups.");
    }
    setCloudRestoreStatus(dataDir, { phase: "downloading", message: "Baixando o snapshot criptografado...", sourceKey, progress: 0 });
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: sourceKey }));
    if (!result.Body) throw new Error("O R2 retornou um backup vazio.");
    const source = result.Body as NodeJS.ReadableStream;
    const total = Number(result.ContentLength || 0);
    let received = 0;
    let lastReported = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (total > 0 && (received - lastReported >= 512 * 1024 || received >= total)) {
          lastReported = received;
          setCloudRestoreStatus(dataDir, {
            phase: "downloading",
            message: `Baixando snapshot: ${Math.min(99, Math.floor(received / total * 100))}%`,
            sourceKey,
            progress: Math.min(45, Math.floor(received / total * 45))
          });
        }
        callback(null, chunk);
      }
    });
    await pipeline(source, progress, fs.createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
    setCloudRestoreStatus(dataDir, { phase: "validating", message: "Arquivo baixado. Validando chave e integridade...", sourceKey, progress: 55 });
    await fs.promises.mkdir(stageDir, { mode: 0o700 });
    await extractEncryptedArchive(archivePath, stageDir, config.encryptionKey, (progress, message) => {
      setCloudRestoreStatus(dataDir, { phase: "validating", message, sourceKey, progress });
    });
    setCloudRestoreStatus(dataDir, { phase: "ready", message: "Snapshot íntegro. Preparando a troca segura dos dados...", sourceKey, progress: 90 });
    return { stageDir, sourceKey };
  } catch (error) {
    restoring = false;
    setCloudRestoreStatus(dataDir, { phase: "failed", message: error instanceof Error ? error.message : "Falha ao preparar a restauração.", sourceKey: requestedSourceKey, progress: undefined });
    await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Applies a previously validated restore after the HTTP server and bot workers have stopped. */
export async function applyPreparedCloudRestore(dataDir: string, stageDir: string) {
  const stage = path.resolve(stageDir);
  if (path.dirname(stage) !== path.resolve(dataDir) || !path.basename(stage).startsWith(".cloud-restore-stage-")) {
    throw new Error("Pasta temporÃ¡ria de restauraÃ§Ã£o invÃ¡lida.");
  }
  const rollbackName = `.cloud-restore-rollback-${Date.now()}-${crypto.randomUUID()}`;
  const rollbackDir = path.join(dataDir, rollbackName);
  await fs.promises.mkdir(rollbackDir, { mode: 0o700 });
  setCloudRestoreStatus(dataDir, { phase: "applying", message: "Aplicando os dados. O serviço será reiniciado em seguida...", sourceKey: restoreStatus?.sourceKey, progress: 95 });
  const completedStatus: CloudRestoreStatus = {
    phase: "completed",
    message: "Restauração concluída. Os dados do snapshot foram carregados com sucesso.",
    sourceKey: restoreStatus?.sourceKey,
    startedAt: restoreStatus?.startedAt,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    progress: 100
  };
  await fs.promises.writeFile(path.join(stage, ".cloud-restore-status.json"), JSON.stringify(completedStatus), { mode: 0o600 });
  await writeJsonJournal(dataDir, { rollbackName, stageName: path.basename(stage), phase: "moving" });
  try {
    const currentEntries = await fs.promises.readdir(dataDir);
    for (const name of currentEntries) {
      if (name === rollbackName || name === path.basename(stage) || name === RESTORE_JOURNAL) continue;
      await fs.promises.rename(path.join(dataDir, name), path.join(rollbackDir, name));
    }
    await writeJsonJournal(dataDir, { rollbackName, stageName: path.basename(stage), phase: "installing" });
    const restoredEntries = await fs.promises.readdir(stage);
    for (const name of restoredEntries) await fs.promises.rename(path.join(stage, name), path.join(dataDir, name));
    await fs.promises.rm(path.join(dataDir, RESTORE_JOURNAL), { force: true });
    await fs.promises.rm(stage, { recursive: true, force: true });
    restoreStatus = completedStatus;
    console.log(`[BACKUP] RestauraÃ§Ã£o aplicada. CÃ³pia anterior preservada em ${rollbackName}.`);
  } catch (error) {
    await recoverInterruptedCloudRestore(dataDir);
    restoring = false;
    throw error;
  }
}

async function writeJsonJournal(dataDir: string, journal: { rollbackName: string; stageName: string; phase: "moving" | "installing" }) {
  const tempPath = path.join(dataDir, `${RESTORE_JOURNAL}.tmp`);
  await fs.promises.writeFile(tempPath, JSON.stringify(journal), { mode: 0o600 });
  await fs.promises.rename(tempPath, path.join(dataDir, RESTORE_JOURNAL));
}

/** If the process dies mid-swap, restore the original files before stores open on boot. */
export function recoverInterruptedCloudRestore(dataDir: string) {
  const journalPath = path.join(dataDir, RESTORE_JOURNAL);
  let journal: { rollbackName?: string; stageName?: string; phase?: "moving" | "installing" };
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    return;
  }
  if (!journal.rollbackName?.startsWith(".cloud-restore-rollback-") || !journal.stageName?.startsWith(".cloud-restore-stage-")
    || !["moving", "installing"].includes(journal.phase || "")) {
    throw new Error("Journal de restauraÃ§Ã£o invÃ¡lido; os dados foram mantidos sem alteraÃ§Ã£o.");
  }
  const rollbackDir = path.join(dataDir, journal.rollbackName);
  if (!fs.existsSync(rollbackDir)) throw new Error("CÃ³pia de seguranÃ§a da restauraÃ§Ã£o ausente; interrompendo inicializaÃ§Ã£o para proteger os dados.");
  const rollbackEntries = fs.readdirSync(rollbackDir);
  const currentEntries = fs.readdirSync(dataDir);
  if (journal.phase === "installing") {
    for (const name of currentEntries) {
      if (name === journal.rollbackName || name === journal.stageName || name === RESTORE_JOURNAL) continue;
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    }
  }
  for (const name of rollbackEntries) fs.renameSync(path.join(rollbackDir, name), path.join(dataDir, name));
  fs.rmSync(rollbackDir, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, journal.stageName), { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  const recoveryStatus: CloudRestoreStatus = {
    phase: "failed",
    message: "A restauração foi interrompida. Os dados anteriores foram recuperados.",
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dataDir, ".cloud-restore-status.json"), JSON.stringify(recoveryStatus), { mode: 0o600 });
  restoreStatus = recoveryStatus;
  console.error("[BACKUP] RestauraÃ§Ã£o interrompida; dados anteriores recuperados automaticamente.");
}

export function startCloudBackup(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const loaded = loadConfig(env);
  if (!loaded) {
    status = { ...status, enabled: false, configured: false, running: false };
    console.log("[BACKUP] Backup remoto aguardando as variáveis R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BACKUP_ENCRYPTION_KEY.");
    return;
  }
  config = loaded;
  client = new S3Client({
    endpoint: loaded.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: loaded.accessKeyId, secretAccessKey: loaded.secretAccessKey }
  });
  status = {
    ...status,
    enabled: true,
    configured: true,
    intervalMinutes: loaded.intervalMs / 60_000,
    retentionDays: loaded.retentionDays
  };
  console.log(`[BACKUP] Backup remoto ativo; intervalo ${status.intervalMinutes} min, retenção ${status.retentionDays} dias.`);
  const run = () => {
    void runCloudBackup(dataDir).catch(() => undefined);
  };
  const firstRun = setTimeout(run, 30_000);
  firstRun.unref();
  schedule = setInterval(run, loaded.intervalMs);
  schedule.unref();
}

export function stopCloudBackup() {
  if (schedule) clearInterval(schedule);
  schedule = undefined;
  client?.destroy();
  client = undefined;
  config = undefined;
}
