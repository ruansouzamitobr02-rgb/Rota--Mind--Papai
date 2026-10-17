import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { verifyPassword, verifyPasswordSync } from "./passwords";
import { HttpError, readJsonBody, readRawBody, RequestRateLimiter, validateAmount, validateEmail } from "./httpSafety";
import { readJsonFile, writeJsonAtomic } from "./storageJson";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { BotProcessProxy } from "./bot/botProcessProxy";
import { DEFAULT_LEADER_CONTACTS } from "./bot/leaderDefaults";
import { LeaderStore, normalizePhone as normalizeLeaderPhone } from "./leaderStore";
import { defaultUserColor, normalizeDispatchAdvantageMs, normalizeDispatchBeatsEmail, normalizeDispatchMatchups, normalizeDispatchPriorityLevel, normalizeUserColor, PanelUserStore, StoredPanelUser } from "./panelUserStore";
import { SupportMessageStore } from "./supportMessageStore";
import { ImageUsageStore } from "./imageUsageStore";
import { validatedRouteUsagePayload } from "./validatedRouteUsage";
import { PushNotificationStore } from "./pushNotificationStore";
import { getCurrentRelease, shouldShowCurrentReleaseToClients } from "./releaseNotes";
import { RomaneioStore } from "./services/romaneio/romaneioStore";
import { computeConditionalDispatchBlockers, computeConditionalDispatchPriorities, ConditionalPriorityClient } from "./services/conditionalDispatchPriority";
import { DispatchRaceCoordinator } from "./services/dispatchRaceCoordinator";
import { applyPreparedCloudRestore, createPortableEncryptedArchive, extractEncryptedArchive, getCloudBackupStatus, getCloudRestoreStatus, listCloudBackupObjects, prepareCloudRestore, recoverInterruptedCloudRestore, runCloudBackup, setCloudRestoreStatus, startCloudBackup, stopCloudBackup } from "./services/cloudBackup";
import { AdminLogEntry, AdminMonitorSnapshot, AdminRoutesSnapshot, AdminSupportMessagesSnapshot, AdminUserDetail, AdminUsersSnapshot, BotSnapshot, DispatchMatchupRule, LeaderContact, PanelUserRole, RouteDispatch, UserPresenceStatus } from "./shared/types";

const port = Number(process.env.PORT || 3000);
const staticDir = path.resolve(process.cwd(), "dist", "desktop", "renderer");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const IMPERSONATION_SESSION_TTL_MS = 1000 * 60 * 60 * 4;
const KEEP_ALIVE_INTERVAL_MS = 1000 * 60 * 10;
const DAILY_SESSION_RESET_HOUR = Number(process.env.DAILY_SESSION_RESET_HOUR || 0);
const DAILY_SESSION_RESET_MINUTE = Number(process.env.DAILY_SESSION_RESET_MINUTE || 0);
const DAILY_SESSION_RESET_ENABLED = process.env.DAILY_SESSION_RESET_ENABLED === "true";
const EAGER_CLIENT_WORKERS = process.env.BOT_EAGER_WORKERS === "true"
  || (process.env.BOT_EAGER_WORKERS !== "false" && Boolean(process.env.RENDER));

function ensureWritableDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const testFile = path.join(dir, `.write-test-${process.pid}`);
  fs.writeFileSync(testFile, "ok");
  fs.rmSync(testFile, { force: true });
}

function resolveDataDir() {
  const requested = path.resolve(process.env.DATA_DIR || process.cwd());

  try {
    ensureWritableDir(requested);
    return requested;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.RENDER || process.env.NODE_ENV === "production") {
      throw new Error(`DATA_DIR sem permissão: ${requested}. Configure um Persistent Disk gravável no Render. Erro: ${message}`);
    }
    const fallback = path.join(os.tmpdir(), "bot-whatsapp");
    console.error(`DATA_DIR sem permissão: ${requested}. Erro: ${message}`);
    console.error(`Usando fallback temporário: ${fallback}. Atenção: dados podem sumir em restart.`);
    ensureWritableDir(fallback);
    return fallback;
  }
}

const dataDir = resolveDataDir();
recoverInterruptedCloudRestore(dataDir);
for (const name of fs.readdirSync(dataDir)) {
  if (name.startsWith(".cloud-restore-stage-")) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
}
const currentRelease = getCurrentRelease();
const portableRestoreTickets = new Map<string, { stageDir: string; createdAt: number }>();
const MAX_PORTABLE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

async function savePortableUpload(request: http.IncomingMessage, outputPath: string) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > MAX_PORTABLE_UPLOAD_BYTES) throw new HttpError(413, "O arquivo ultrapassa o limite de 2 GB.");
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > MAX_PORTABLE_UPLOAD_BYTES ? new HttpError(413, "O arquivo ultrapassa o limite de 2 GB.") : null, chunk);
    }
  });
  await pipeline(request, limit, fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
  if (received < 36) throw new HttpError(400, "O arquivo está vazio ou incompleto.");
}

function countPortableRestoreFiles(stageDir: string) {
  const summary = { files: 0, clients: 0, routes: 0, validatedRoutes: 0 };
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(fullPath); continue; }
      if (!entry.isFile()) continue;
      summary.files++;
      const normalized = fullPath.replace(/\\/g, "/").toLowerCase();
      if (!normalized.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
        if (normalized.endsWith("/panel_users.json") && Array.isArray(parsed)) {
          summary.clients = parsed.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === "client").length;
        }
        if (normalized.endsWith("/route_history.json") && Array.isArray(parsed)) {
          summary.routes += parsed.length;
          summary.validatedRoutes += parsed.filter((item) => item && typeof item === "object"
            && ((item as Record<string, unknown>).decisionStatus === "validated" || (item as Record<string, unknown>).validated === true)).length;
        }
      } catch { /* An optional JSON file can have a different format. */ }
    }
  }
  visit(stageDir);
  return summary;
}

type PanelUserRecord = {
  password: string;
  role: PanelUserRole;
  blocked: boolean;
  color: string;
  dispatchPriorityLevel: number;
  dispatchBeatsEmail?: string;
  dispatchAdvantageMs: number;
  dispatchMatchups: DispatchMatchupRule[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  lastSeenAt?: string;
  lastSeenReleaseId?: string;
  lastSeenReleaseAt?: string;
  totalUsageMs: number;
  loginHistory: StoredPanelUser["loginHistory"];
  source?: "environment" | "panel";
  sessionVersion?: number;
};

function parseList(value: string | undefined) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePhone(value: string) {
  return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function createUserRecord(email: string, password: string, role: PanelUserRole, overrides: Partial<PanelUserRecord> = {}): PanelUserRecord {
  const now = new Date().toISOString();
  return {
    password,
    role,
    blocked: false,
    color: defaultUserColor(email),
    dispatchPriorityLevel: 0,
    dispatchAdvantageMs: 400,
    dispatchMatchups: [],
    createdAt: now,
    updatedAt: now,
    totalUsageMs: 0,
    loginHistory: [],
    ...overrides
  };
}

function parsePanelUsers(envUsers: string | undefined, adminEmails: Set<string>) {
  const users = new Map<string, PanelUserRecord>();
  const raw = String(envUsers || "").trim();
  for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [email, password, role, color, dispatchPriorityLevel] = part.split(":").map((item) => item.trim());
    if (!email || !password) continue;
    const normalizedEmail = email.toLowerCase();
    const userRole: PanelUserRole = role === "admin" || adminEmails.has(normalizedEmail) ? "admin" : "client";
    users.set(normalizedEmail, createUserRecord(normalizedEmail, password, userRole, {
      color: normalizeUserColor(color, normalizedEmail),
      dispatchPriorityLevel: normalizeDispatchPriorityLevel(dispatchPriorityLevel)
    }));
  }
  return users;
}

function mergeStoredUsers(users: Map<string, PanelUserRecord>, storedUsers: StoredPanelUser[], adminEmails: Set<string>) {
  for (const storedUser of storedUsers) {
    const configuredUser = users.get(storedUser.email);
    if (!configuredUser && storedUser.source !== "panel") continue;
    const managedInPanel = storedUser.source === "panel";
    const userRole: PanelUserRole = managedInPanel ? storedUser.role : configuredUser!.role === "admin" || adminEmails.has(storedUser.email) ? "admin" : "client";
    const password = managedInPanel || verifyPasswordSync(configuredUser!.password, storedUser.password) ? storedUser.password : configuredUser!.password;
    users.set(storedUser.email, createUserRecord(storedUser.email, password, userRole, {
      ...storedUser,
      password,
      role: userRole
    }));
  }
  return users;
}

const configuredAdminEmails = new Set(parseList(process.env.PANEL_ADMIN_EMAILS).map((item) => item.toLowerCase()));
const adminPhoneNumbers = parseList(process.env.ADMIN_PHONE_NUMBERS || process.env.ADMIN_PHONES)
  .map(normalizePhone)
  .filter(Boolean);
const envLeaderContacts: LeaderContact[] = parseList(process.env.LEADER_CONTACTS)
  .map((item) => {
    const [name, phone] = item.split(":").map((part) => part.trim());
    return { name, phone: normalizeLeaderPhone(phone || "") };
  })
  .filter((item) => item.name && item.phone);
const leaderStore = new LeaderStore(path.join(dataDir, "leaders.json"), [...DEFAULT_LEADER_CONTACTS, ...envLeaderContacts]);
const panelUserStore = new PanelUserStore(path.join(dataDir, "panel_users.json"));
const supportMessageStore = new SupportMessageStore(path.join(dataDir, "support_messages.json"));
const imageUsageStore = new ImageUsageStore(path.join(dataDir, "image_usage.json"));
const panelUsers = mergeStoredUsers(parsePanelUsers(
  process.env.PANEL_USERS,
  configuredAdminEmails
), panelUserStore.all(), configuredAdminEmails);
const isolatedClientEmail = String(process.env.ISOLATED_CLIENT_EMAIL || "").trim().toLowerCase();
const pushNotificationStore = new PushNotificationStore(
  path.join(dataDir, "push_notifications.json"),
  { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY },
  process.env.WEB_PUSH_SUBJECT || "mailto:admin@botrotas.local"
);
const panelSessionSecret = process.env.PANEL_SESSION_SECRET || crypto.randomBytes(32).toString("base64url");
const revokedSessionsPath = path.join(dataDir, "revoked_sessions.json");
const revokedSessions = new Map<string, number>(readJsonFile<[string, number][]>(revokedSessionsPath, () => [],
  (value) => Array.isArray(value) && value.every((entry) => Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1]))));
const loginLimiter = new RequestRateLimiter(200, 5 * 60_000);
const accountLoginLimiter = new RequestRateLimiter(20, 5 * 60_000);
const supportLimiter = new RequestRateLimiter(5, 60_000);
const lastPresenceWrite = new Map<string, number>();
const keepAliveUrl =
  process.env.KEEP_ALIVE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "");
const primaryPanelEmail = Array.from(panelUsers.keys())[0] || "";

console.log("Ambiente:", process.env.RENDER ? "Render/produção" : process.env.NODE_ENV === "production" ? "produção" : "desenvolvimento");
if (!String(process.env.PANEL_USERS || "").trim()) {
  console.error("PANEL_USERS não configurado. Login ficará bloqueado até configurar PANEL_USERS=email:senha:role nas variáveis de ambiente.");
}
if (!process.env.PANEL_SESSION_SECRET) {
  console.warn("PANEL_SESSION_SECRET não configurado. Sessões serão invalidadas a cada restart.");
}
console.log("Painel de usuarios habilitados:", Array.from(panelUsers.keys()).join(", ") || "nenhum");
if (isolatedClientEmail) {
  if (!panelUsers.has(isolatedClientEmail)) {
    console.error(`ISOLATED_CLIENT_EMAIL não existe em PANEL_USERS: ${isolatedClientEmail}`);
  } else {
    console.log(`Modo isolado ativo: somente o bot de ${isolatedClientEmail} será iniciado neste serviço.`);
  }
}
console.log("Administradores do painel:", Array.from(panelUsers.entries()).filter(([, user]) => user.role === "admin").map(([email]) => email).join(", ") || "nenhum");
if (!configuredAdminEmails.size && !Array.from(panelUsers.values()).some((user) => user.role === "admin")) {
  console.error("Nenhum administrador configurado. Use PANEL_ADMIN_EMAILS ou marque um usuário com :admin em PANEL_USERS.");
}

type Client = {
  email: string;
  response: http.ServerResponse;
};

const bots = new Map<string, BotProcessProxy>();
const clients = new Set<Client>();
const adminClients = new Set<http.ServerResponse>();
const streamAuth = new Map<http.ServerResponse, { token: string; email: string }>();
function registerStream(response: http.ServerResponse, url: URL, email: string) {
  if (Array.from(streamAuth.values()).filter((stream) => stream.email === email).length >= 10) throw new HttpError(429, "Limite de conexões simultâneas atingido.");
  streamAuth.set(response, { token: url.searchParams.get("token") || "", email });
  response.once("close", () => streamAuth.delete(response));
}
function writeStream(response: http.ServerResponse, payload: string) {
  const stream = streamAuth.get(response);
  if (!stream || !verifySessionClaims(stream.token) || panelUsers.get(stream.email)?.blocked || response.destroyed || response.writableEnded) {
    response.end();
    return;
  }
  // A slow/disconnected browser must not accumulate unlimited snapshots in RAM.
  if (!response.write(payload)) response.destroy();
}
const streamHeartbeat = setInterval(() => {
  for (const response of streamAuth.keys()) writeStream(response, ": heartbeat\n\n");
}, 15_000);
streamHeartbeat.unref();
const lastSnapshotState = new Map<string, { qrCode: string; logId: string }>();
const lastCriticalBotState = new Map<string, { status: string; monitoringEnabled: boolean; analysisKey: string; incidentId: string }>();
let lastAdminPendingRouteIds: Set<string> | undefined;
const pendingSnapshotBots = new Map<string, BotProcessProxy>();
let snapshotFanoutScheduled = false;
const appliedConditionalPriority = new Map<string, { level: number; delayMs: number; workerPid?: number }>();
const dispatchRaceCoordinator = new DispatchRaceCoordinator();
let conditionalPriorityTimer: NodeJS.Timeout | undefined;

function scheduleConditionalPrioritySync() {
  if (conditionalPriorityTimer) return;
  conditionalPriorityTimer = setTimeout(() => {
    conditionalPriorityTimer = undefined;
    void syncConditionalDispatchPriorities();
  }, 20);
  conditionalPriorityTimer.unref?.();
}

async function syncConditionalDispatchPriorities() {
  const priorities = computeConditionalDispatchPriorities(getConditionalPriorityClients());

  await Promise.all(Array.from(bots.entries()).map(async ([email, bot]) => {
    const nextDelayMs = priorities.get(email) || 0;
    const nextLevel = nextDelayMs > 0 ? 1 : 0;
    const workerPid = bot.getWorkerPid();
    const applied = appliedConditionalPriority.get(email);
    if (applied?.delayMs === nextDelayMs && applied.workerPid === workerPid) return;
    appliedConditionalPriority.set(email, { level: nextLevel, delayMs: nextDelayMs, workerPid });
    try {
      await bot.setDispatchPriorityDelayMs(nextDelayMs);
    } catch (error) {
      appliedConditionalPriority.delete(email);
      console.error(`Falha ao sincronizar prioridade condicional de ${email}:`, error);
    }
  }));
}

function getConditionalPriorityClients(): ConditionalPriorityClient[] {
  return Array.from(bots.entries()).map(([email, bot]) => {
    const snapshot = bot.getSnapshot();
    const targetGroupKey = String(snapshot.config.grupoAlvoJid || snapshot.config.grupoAlvoNome || "").trim().toLowerCase();
    return {
      email,
      configuredLevel: panelUsers.get(email)?.dispatchPriorityLevel || 0,
      beatsEmail: panelUsers.get(email)?.dispatchBeatsEmail,
      advantageMs: panelUsers.get(email)?.dispatchAdvantageMs,
      matchups: panelUsers.get(email)?.dispatchMatchups,
      priorityUpdatedAt: panelUsers.get(email)?.updatedAt,
      connected: snapshot.status === "connected",
      monitoringEnabled: snapshot.monitoringEnabled,
      monitoringMode: snapshot.monitoringMode,
      targetDispatchMode: snapshot.config.targetDispatchMode,
      targetGroupKey
    };
  });
}

function scheduleSnapshotFanout(email: string, bot: BotProcessProxy) {
  pendingSnapshotBots.set(email, bot);
  scheduleConditionalPrioritySync();
  if (snapshotFanoutScheduled) return;

  snapshotFanoutScheduled = true;
  setImmediate(() => {
    snapshotFanoutScheduled = false;
    const pending = Array.from(pendingSnapshotBots.entries());
    pendingSnapshotBots.clear();
    if (!pending.length) return;

    const ready = pending.filter(([, pendingBot]) => !pendingBot.isCriticalDispatchActive());
    const delayed = pending.filter(([, pendingBot]) => pendingBot.isCriticalDispatchActive());
    for (const [pendingEmail, pendingBot] of ready) {
      handleCriticalBotNotifications(pendingEmail, pendingBot.getSnapshot());
      broadcastSnapshot(pendingEmail);
      logSnapshot(pendingEmail);
    }
    const anyCriticalDispatch = Array.from(bots.values()).some((bot) => bot.isCriticalDispatchActive());
    if (ready.length && !anyCriticalDispatch) {
      // O painel administrativo agrega todos os clientes. Atualize uma vez por
      // ciclo, mesmo quando vários sockets emitirem snapshots juntos.
      broadcastAdminSnapshot();
    }
    if (delayed.length) {
      const retryTimer = setTimeout(() => {
        for (const [pendingEmail, pendingBot] of delayed) scheduleSnapshotFanout(pendingEmail, pendingBot);
      }, 75);
      retryTimer.unref?.();
    }
  });
}

function getUserStorageKey(email: string) {
  return email.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

function getUserDir(email: string) {
  return path.join(dataDir, "users", getUserStorageKey(email));
}

function assertUniqueStorageKey(email: string, previousEmail?: string) {
  const key = getUserStorageKey(email);
  for (const existing of panelUsers.keys()) {
    if (existing !== email && existing !== previousEmail && getUserStorageKey(existing) === key) {
      throw new HttpError(409, "Este email conflita com o diretório de outro usuário.");
    }
  }
}

function getRomaneioStoreForEmail(email: string) {
  return new RomaneioStore(path.join(getUserDir(email), "romaneio"));
}

async function renameUserStorage(oldEmail: string, nextEmail: string) {
  if (oldEmail === nextEmail) return;

  const oldDir = getUserDir(oldEmail);
  const nextDir = getUserDir(nextEmail);
  if (oldDir !== nextDir && fs.existsSync(nextDir)) throw new HttpError(409, "O diretório de destino já contém dados. Renomeação cancelada.");

  const existingBot = bots.get(oldEmail);
  if (existingBot) {
    await existingBot.shutdown();
    bots.delete(oldEmail);
    appliedConditionalPriority.delete(oldEmail);
    scheduleConditionalPrioritySync();
  }

  if (fs.existsSync(oldDir) && !fs.existsSync(nextDir)) {
    fs.mkdirSync(path.dirname(nextDir), { recursive: true });
    fs.renameSync(oldDir, nextDir);
  }
  const routeHistoryPath = path.join(nextDir, "route_history.json");
  if (fs.existsSync(routeHistoryPath)) {
    try {
      const routes = JSON.parse(fs.readFileSync(routeHistoryPath, "utf-8"));
      if (Array.isArray(routes)) {
        writeJsonAtomic(
          routeHistoryPath,
          routes.map((route) => ({ ...route, clientEmail: nextEmail }))
        );
      }
    } catch {
      // Mantém o histórico original se o arquivo estiver inválido.
    }
  }
}

function getBotForEmail(email: string) {
  const normalizedEmail = email.toLowerCase();
  if (isolatedClientEmail && normalizedEmail !== isolatedClientEmail) {
    throw new Error("Este serviço está isolado para outro cliente.");
  }
  const existing = bots.get(normalizedEmail);
  if (existing) return existing;

  const userDir = getUserDir(normalizedEmail);
  const userAuthDir = path.join(userDir, "auth_info");
  const userConfigPath = path.join(userDir, "config.json");
  const userRouteStorePath = path.join(userDir, "route_history.json");
  const userDispatchQueuePath = path.join(userDir, "dispatch_queue.json");
  const userLogStorePath = path.join(userDir, "bot_logs.json");
  const userTelemetryPath = path.join(userDir, "dispatch_telemetry.json");
  const userOcrAnalysisHistoryPath = path.join(userDir, "ocr_analysis_history.json");
  const userRomaneioDir = path.join(userDir, "romaneio");
  const panelUser = panelUsers.get(normalizedEmail);

  if (normalizedEmail === primaryPanelEmail) {
    const legacyAuthDir = path.join(dataDir, "auth_info");
    const legacyConfigPath = path.join(dataDir, "config.json");
    if (!fs.existsSync(userAuthDir) && fs.existsSync(legacyAuthDir)) {
      fs.mkdirSync(userDir, { recursive: true });
      fs.cpSync(legacyAuthDir, userAuthDir, { recursive: true });
    }
    if (!fs.existsSync(userConfigPath) && fs.existsSync(legacyConfigPath)) {
      fs.mkdirSync(userDir, { recursive: true });
      fs.copyFileSync(legacyConfigPath, userConfigPath);
    }
  }

  const nextBot = new BotProcessProxy({
    authDir: userAuthDir,
    configPath: userConfigPath,
    routeStorePath: userRouteStorePath,
    dispatchQueuePath: userDispatchQueuePath,
    telemetryPath: userTelemetryPath,
    ocrAnalysisHistoryPath: userOcrAnalysisHistoryPath,
    logStorePath: userLogStorePath,
    romaneioDir: userRomaneioDir,
    clientEmail: normalizedEmail,
    // A prioridade configurada só é aplicada pelo coordenador quando existe
    // outro cliente armado para o mesmo grupo. Sozinho, todo bot roda em zero.
    dispatchPriorityLevel: 0,
    adminPhoneNumbers,
    leaderContacts: leaderStore.all(),
    autoClearInvalidSession: true,
    deferSnapshotPayload: true
  });

  nextBot.on("snapshot", () => {
    scheduleSnapshotFanout(normalizedEmail, nextBot);
  });
  nextBot.on("image-analysis", (analysis) => {
    // Persistência e atualização dos painéis não podem bloquear a continuação
    // da análise até o relay automático.
    setImmediate(() => {
      try {
        imageUsageStore.record({ ...analysis, clientEmail: normalizedEmail });
        scheduleSnapshotFanout(normalizedEmail, nextBot);
      } catch (error) {
        console.error(`Falha ao registrar consumo de imagem de ${normalizedEmail}:`, error);
      }
    });
  });
  nextBot.on("route-auto-validated", (validation: { routeId: string; analysisId?: string; leaderName?: string; route?: RouteDispatch }) => {
    setImmediate(() => {
      const reviewedBy = `Líder: ${validation.leaderName || "identificado"}`;
      const route = validation.route || nextBot.getRoutes().find((item) => item.id === validation.routeId);
      if (approveRouteImageUsage(route, normalizedEmail, reviewedBy)) {
        console.log(`[IA] Consumo aprovado automaticamente por reação do líder: ${normalizedEmail} / ${validation.routeId}.`);
      }
      scheduleSnapshotFanout(normalizedEmail, nextBot);
    });
  });
  nextBot.on("dispatch-gate-request", (request: { id: string; clientEmail: string; groupKey: string; eventDetectedAt: number; eventKey?: string; targetDispatchMode?: "manual" | "ocr" }) => {
    // Critical sends defer the large snapshot. Use the mode of this actual
    // request so a recent mode change cannot attach it to the wrong race.
    const clients = getConditionalPriorityClients().map((client) => client.email === normalizedEmail
      ? { ...client, targetDispatchMode: request.targetDispatchMode || client.targetDispatchMode, targetGroupKey: request.groupKey }
      : client);
    const blockers = computeConditionalDispatchBlockers(clients).get(normalizedEmail) || [];
    void dispatchRaceCoordinator.request({
      clientEmail: normalizedEmail,
      groupKey: request.groupKey,
      eventDetectedAt: request.eventDetectedAt,
      eventKey: request.eventKey,
      blockers
    }).then((grant) => {
      nextBot.resolveDispatchGate(request.id, grant);
    }).catch((error) => {
      nextBot.resolveDispatchGate(request.id, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  nextBot.on("dispatch-gate-relay", (relay: { token: string; clientEmail: string; relayedAt: number }) => {
    dispatchRaceCoordinator.confirmRelay(relay.token, normalizedEmail, relay.relayedAt);
  });
  nextBot.on("dispatch-gate-failure", (failure: { token: string; clientEmail: string; failedAt: number }) => {
    dispatchRaceCoordinator.failRelay(failure.token, normalizedEmail);
  });
  nextBot.on("dispatch-race-event", (event: { groupKey: string; eventDetectedAt: number; eventKey: string; state: "processing" | "ready" | "unavailable" }) => {
    dispatchRaceCoordinator.announce({ ...event, clientEmail: normalizedEmail });
  });
  nextBot.on("worker-exit", () => {
    dispatchRaceCoordinator.cancelClient(normalizedEmail, "O envio anterior foi interrompido e será recuperado automaticamente.");
  });

  bots.set(normalizedEmail, nextBot);
  scheduleConditionalPrioritySync();
  return nextBot;
}

async function preloadClientWorkers() {
  if (!EAGER_CLIENT_WORKERS) return;
  const emails = getClientEmails();
  if (!emails.length) return;

  console.log(`Pré-carregando ${emails.length} worker(s) de cliente para eliminar partida fria...`);
  const results = await Promise.allSettled(emails.map(async (email) => {
    const bot = getBotForEmail(email);
    await bot.ready();
    return email;
  }));
  const ready = results.filter((result) => result.status === "fulfilled").length;
  console.log(`Workers prontos: ${ready}/${emails.length}.`);
}

function sendJson(response: http.ServerResponse, statusCode: number, data: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

async function readMultipartFile(request: http.IncomingMessage) {
  const contentType = String(request.headers["content-type"] || "");
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error("Envie o arquivo como multipart/form-data.");

  const body = await readRawBody(request);
  const bodyText = body.toString("latin1");
  const marker = `--${boundary}`;
  const parts = bodyText.split(marker).filter((part) => part.includes("Content-Disposition"));
  const filePart = parts.find((part) => /filename=/i.test(part));
  if (!filePart) throw new Error("Arquivo do romaneio não encontrado.");

  const [rawHeaders, ...rest] = filePart.split("\r\n\r\n");
  const content = rest.join("\r\n\r\n").replace(/\r\n--$/, "").replace(/\r\n$/, "");
  const fileName = rawHeaders.match(/filename="([^"]+)"/i)?.[1] || "romaneio.xlsx";
  if (!/\.xlsx$/i.test(fileName)) throw new Error("Envie um arquivo .xlsx.");

  return {
    fileName,
    buffer: Buffer.from(content, "latin1")
  };
}

function base64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload: string) {
  return crypto.createHmac("sha256", panelSessionSecret).update(payload).digest("base64url");
}

type PanelSessionClaims = {
  email: string;
  exp: number;
  id: string;
  authTag: string;
  impersonatedBy?: string;
};

function createSessionToken(email: string, impersonatedBy?: string) {
  const payload = base64Url(JSON.stringify({
    email,
    id: crypto.randomUUID(),
    authTag: sessionAuthTag(email),
    impersonatorAuthTag: impersonatedBy ? sessionAuthTag(impersonatedBy) : undefined,
    exp: Date.now() + (impersonatedBy ? IMPERSONATION_SESSION_TTL_MS : SESSION_TTL_MS),
    impersonatedBy: impersonatedBy || undefined
  }));
  return `${payload}.${signPayload(payload)}`;
}

function sessionAuthTag(email: string) {
  const user = panelUsers.get(email);
  return crypto.createHmac("sha256", panelSessionSecret).update(`${user?.password}:${user?.role}:${user?.blocked}:${user?.sessionVersion || 0}`).digest("base64url");
}

function verifySessionClaims(token: string): PanelSessionClaims | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || token.split(".").length !== 2) return undefined;
  const expected = signPayload(payload);
  if (signature.length !== expected.length) return undefined;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const email = String(parsed.email || "").toLowerCase();
    const impersonatedBy = String(parsed.impersonatedBy || "").trim().toLowerCase() || undefined;
    if (!email || !panelUsers.has(email) || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return undefined;
    if (typeof parsed.id !== "string" || revokedSessions.has(parsed.id) || parsed.authTag !== sessionAuthTag(email)) return undefined;
    if (impersonatedBy && (panelUsers.get(impersonatedBy)?.role !== "admin" || panelUsers.get(impersonatedBy)?.blocked || parsed.impersonatorAuthTag !== sessionAuthTag(impersonatedBy))) return undefined;
    return { email, exp: parsed.exp, id: parsed.id, authTag: parsed.authTag, impersonatedBy };
  } catch {
    return undefined;
  }
}

function verifySessionToken(token: string): string | undefined {
  return verifySessionClaims(token)?.email;
}

function getSessionClaims(request: http.IncomingMessage) {
  return verifySessionClaims(String(request.headers["x-panel-token"] || "").trim());
}

function getAuthorizedEmail(request: http.IncomingMessage) {
  if (!panelUsers.size) return undefined;
  const token = String(request.headers["x-panel-token"] || "").trim();
  const tokenEmail = verifySessionToken(token);
  if (tokenEmail && isEmailAllowedOnThisService(tokenEmail)) return tokenEmail;

  return undefined;
}

function getAuthorizedEmailFromUrl(url: URL) {
  const tokenEmail = verifySessionToken(String(url.searchParams.get("token") || "").trim());
  if (tokenEmail && !panelUsers.get(tokenEmail)?.blocked && isEmailAllowedOnThisService(tokenEmail)) return tokenEmail;
  return undefined;
}

function requireAuth(request: http.IncomingMessage, response: http.ServerResponse) {
  const email = getAuthorizedEmail(request);
  if (email) {
    if (panelUsers.get(email)?.blocked) {
      sendJson(response, 403, { error: "Acesso bloqueado. Fale com o suporte para liberar sua conta." });
      return undefined;
    }
    touchPanelUser(email);
    return email;
  }
  sendJson(response, 401, { error: "Login obrigatório." });
  return undefined;
}

function syncPanelUser(user: StoredPanelUser) {
  panelUsers.set(user.email, createUserRecord(user.email, user.password, user.role, user));
  broadcastAdminSnapshot();
}

function touchPanelUser(email: string) {
  const user = panelUsers.get(email);
  if (!user) return;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const lastSeenMs = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
  const delta = lastSeenMs && nowMs - lastSeenMs <= 1000 * 60 * 5 ? nowMs - lastSeenMs : 0;
  user.lastSeenAt = now;
  user.totalUsageMs += delta;
  if (nowMs - (lastPresenceWrite.get(email) || 0) >= 15_000) {
    panelUserStore.touch(email);
    lastPresenceWrite.set(email, nowMs);
  }
}

function getUserRole(email: string): PanelUserRole {
  return panelUsers.get(email)?.role || "client";
}

function requireAdmin(email: string, response: http.ServerResponse) {
  if (getUserRole(email) === "admin") return true;
  sendJson(response, 403, { error: "Acesso de administrador obrigatório." });
  return false;
}

function getClientEmails() {
  if (isolatedClientEmail) {
    const isolatedUser = panelUsers.get(isolatedClientEmail);
    return isolatedUser?.role === "client" ? [isolatedClientEmail] : [];
  }
  return Array.from(panelUsers.entries())
    .filter(([, user]) => user.role !== "admin")
    .map(([email]) => email);
}

function isEmailAllowedOnThisService(email: string) {
  return !isolatedClientEmail || email.toLowerCase() === isolatedClientEmail;
}

function toUserSummary(email: string, user: PanelUserRecord) {
  const botSnapshot = bots.get(email)?.getSnapshot();
  const lastSeenMs = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
  const ageMs = lastSeenMs ? Date.now() - lastSeenMs : Number.POSITIVE_INFINITY;
  const presenceStatus: UserPresenceStatus = ageMs <= 1000 * 45 ? "online" : ageMs <= 1000 * 60 * 5 ? "recent" : "offline";

  return {
    email,
    role: user.role,
    blocked: user.blocked,
    color: user.color || defaultUserColor(email),
    dispatchPriorityLevel: normalizeDispatchPriorityLevel(user.dispatchPriorityLevel),
    dispatchBeatsEmail: normalizeDispatchBeatsEmail(user.dispatchBeatsEmail, email),
    dispatchAdvantageMs: normalizeDispatchAdvantageMs(user.dispatchAdvantageMs),
    dispatchMatchups: normalizeDispatchMatchups(user.dispatchMatchups, email),
    presenceStatus,
    panelOnline: presenceStatus === "online",
    botOpen: Boolean(botSnapshot && ["connected", "connecting", "waiting_qr", "reconnecting"].includes(botSnapshot.status)),
    botStatus: botSnapshot?.status,
    monitoringEnabled: botSnapshot?.monitoringEnabled,
    performanceMetrics: botSnapshot?.performanceMetrics,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    lastSeenAt: user.lastSeenAt,
    totalUsageMs: user.totalUsageMs,
    loginCount: user.loginHistory.length
  };
}

function getAdminUsersSnapshot(): AdminUsersSnapshot {
  return {
    users: Array.from(panelUsers.entries())
      .map(([email, user]) => toUserSummary(email, user))
      .sort((a, b) => a.email.localeCompare(b.email))
  };
}

function getLastWhatsAppConnectionAt(logs: AdminUserDetail["logs"]) {
  const found = [...logs].reverse().find((log) => /conectad|online|sessão carregada|bot iniciado/i.test(log.message));
  return found?.timestamp;
}

function getAdminUserDetail(email: string): AdminUserDetail | undefined {
  const normalizedEmail = email.trim().toLowerCase();
  const user = panelUsers.get(normalizedEmail);
  if (!user) return undefined;

  const snapshot = getBotForEmail(normalizedEmail).getSnapshot();
  return {
    ...toUserSummary(normalizedEmail, user),
    config: snapshot.config,
    groups: snapshot.groups,
    botStatus: snapshot.status,
    monitoringEnabled: snapshot.monitoringEnabled,
    monitoringMode: snapshot.monitoringMode,
    performanceMetrics: snapshot.performanceMetrics,
    lastWhatsAppConnectionAt: getLastWhatsAppConnectionAt(snapshot.logs),
    logs: snapshot.logs.slice(0, 250),
    routes: snapshot.routeDispatches || [],
    loginHistory: user.loginHistory,
    statusEvents: snapshot.statusEvents || []
  };
}

function getAdminRoutesSnapshot(): AdminRoutesSnapshot {
  const colorByEmail = new Map(Array.from(panelUsers.entries()).map(([email, user]) => [email, user.color || defaultUserColor(email)]));
  const allRoutes = getClientEmails()
    .flatMap((email) => getBotForEmail(email).getRoutes())
    .map((route) => ({ ...route, clientColor: colorByEmail.get(route.clientEmail) || defaultUserColor(route.clientEmail) }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingReactionRoutes = allRoutes
    .filter((route) => {
      const pending = (route.decisionStatus || (route.validated ? "validated" : "pending")) === "pending";
      const reacted = Boolean(
        route.reactions.length ||
        route.reactionsHistory?.length ||
        route.lastReactionState?.status === "active" ||
        route.lastReactionState?.status === "removed"
      );
      return pending && Boolean(route.ocr) && reacted;
    })
    .sort((a, b) => {
      const aLast = a.reactions[0]?.timestamp || a.updatedAt;
      const bLast = b.reactions[0]?.timestamp || b.updatedAt;
      return new Date(bLast).getTime() - new Date(aLast).getTime();
    });
  const routes = allRoutes;
  const clients = new Set(allRoutes.map((route) => route.clientEmail).filter(Boolean));
  return {
    routes,
    pendingReactionRoutes,
    totals: {
      routes: allRoutes.length,
      validated: allRoutes.filter((route) => route.validated).length,
      rejected: allRoutes.filter((route) => (route.decisionStatus || (route.validated ? "validated" : "pending")) === "rejected").length,
      pending: allRoutes.filter((route) => (route.decisionStatus || (route.validated ? "validated" : "pending")) === "pending").length,
      reactions: allRoutes.reduce((total, route) => total + route.reactions.length, 0),
      removedReactions: allRoutes.filter((route) => route.lastReactionState?.status === "removed").length,
      clients: clients.size
    }
  };
}

async function validateAdminRoute(routeId: string, adminEmail: string) {
  for (const email of getClientEmails()) {
    const bot = getBotForEmail(email);
    const route = bot.getRoutes().find((item) => item.id === routeId);
    if (await bot.validateRoute(routeId, adminEmail)) {
      approveRouteImageUsage(route, email, adminEmail);
      return true;
    }
  }
  return false;
}

function approveRouteImageUsage(route: RouteDispatch | undefined, clientEmail: string, reviewedBy: string) {
  if (!route) return false;
  const changed = imageUsageStore.decideValidatedRoute(validatedRouteUsagePayload(route, clientEmail), reviewedBy);
  if (!changed) return false;
  const entry = imageUsageStore.snapshot().ledgerEntries?.find((item) => item.routeDispatchId === route.id);
  if (entry?.paymentStatus === "prepaid") {
    sendClientPush(clientEmail, {
      title: "Rota confirmada",
      body: `${entry.gaiola || entry.route || "Rota"} foi confirmada e adicionada à sua relação de rotas.`,
      tag: `route-confirmed:${route.id}`,
      url: "/?tab=image"
    });
  } else if (entry) {
    const finance = imageUsageStore.clientSnapshot(clientEmail);
    const cadence = imageUsageStore.paymentEveryRoutes(clientEmail);
    const atBillingBatch = cadence > 0 && finance.unpaidRoutes > 0 && finance.unpaidRoutes % cadence === 0;
    sendClientPush(clientEmail, {
      title: atBillingBatch ? `Ciclo de ${cadence} rotas concluído` : "Rota confirmada",
      body: atBillingBatch
        ? `${finance.unpaidRoutes} rotas confirmadas desde o último pagamento. Total em aberto: ${(finance.amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`
        : `${entry.gaiola || entry.route || "Rota"} foi confirmada.`,
      tag: atBillingBatch ? `route-billing-batch:${clientEmail}:${finance.unpaidRoutes}` : `route-confirmed:${route.id}`,
      url: "/?tab=image"
    });
  }
  return true;
}

async function rejectAdminRoute(routeId: string, adminEmail: string, reason?: string) {
  for (const email of getClientEmails()) {
    const bot = getBotForEmail(email);
    const route = bot.getRoutes().find((item) => item.id === routeId);
    if (await bot.rejectRoute(routeId, adminEmail, reason)) {
      imageUsageStore.decideForRoute(route?.ocr?.analysisId, routeId, "excluded", adminEmail);
      return true;
    }
  }
  return false;
}

async function bulkDecideAdminRoutes(routeIds: string[], adminEmail: string, decision: "validate" | "reject", reason?: string) {
  let changed = 0;
  for (const routeId of routeIds) {
    const ok = decision === "validate"
      ? await validateAdminRoute(routeId, adminEmail)
      : await rejectAdminRoute(routeId, adminEmail, reason);
    if (ok) changed += 1;
  }
  return changed;
}

function findRouteForImageUsage(entry: { id: string; routeDispatchId?: string }) {
  for (const email of getClientEmails()) {
    const route = getBotForEmail(email).getRoutes().find((item) =>
      item.id === entry.routeDispatchId || item.ocr?.analysisId === entry.id
    );
    if (route) return route;
  }
  return undefined;
}

function getAdminSupportMessagesSnapshot(): AdminSupportMessagesSnapshot {
  const messages = supportMessageStore.all().map((message) => ({
    ...message,
    clientColor: panelUsers.get(message.email)?.color || defaultUserColor(message.email)
  }));
  return {
    messages,
    unread: messages.filter((message) => !message.read).length
  };
}

function getAdminLogsSnapshot(): AdminLogEntry[] {
  const colorByEmail = new Map(Array.from(panelUsers.entries()).map(([email, user]) => [email, user.color || defaultUserColor(email)]));
  return getClientEmails()
    .flatMap((email) =>
      getBotForEmail(email).getSnapshot().logs.map((log) => ({
        ...log,
        message: presentAiTerminology(log.message),
        clientEmail: email,
        clientColor: colorByEmail.get(email) || defaultUserColor(email)
      }))
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 1000);
}

function presentAiTerminology(message: string) {
  return String(message || "").replace(/\bOCR\b/g, "IA");
}

function sanitizeTimelineForClient(timeline: any) {
  if (!timeline || typeof timeline !== "object") return timeline;
  const { dispatchPriority, priorityDelayMs, ...safeTimeline } = timeline;
  safeTimeline.events = Array.isArray(timeline.events)
    ? timeline.events.filter((event: any) => !/(prioridade|sincroniza|coordena)/i.test(String(event?.label || "")))
    : timeline.events;
  return safeTimeline;
}

function isPrivateDispatchLog(message: string) {
  return /(prioridade de corrida|sincroniza.{0,8}do disparo|coordena.{0,12}(disparo|relay)|configurado para (vencer|perder)|disparo bloqueado)/i.test(String(message || ""));
}

function sanitizeClientSnapshot(snapshot: BotSnapshot): BotSnapshot {
  const performanceMetrics = snapshot.performanceMetrics
    ? (({ dispatchPriority, ...safeMetrics }) => safeMetrics)(snapshot.performanceMetrics as any)
    : undefined;
  const routeDispatches = snapshot.routeDispatches?.map((route) => ({
    ...route,
    dispatchTimeline: sanitizeTimelineForClient(route.dispatchTimeline)
  }));
  return {
    ...snapshot,
    performanceMetrics,
    routeDispatches
  };
}

function getAdminMonitorSnapshot(): AdminMonitorSnapshot {
  return {
    routes: getAdminRoutesSnapshot(),
    users: getAdminUsersSnapshot(),
    support: getAdminSupportMessagesSnapshot(),
    logs: getAdminLogsSnapshot(),
    leaders: leaderStore.all(),
    imageUsage: imageUsageStore.snapshot()
  };
}

function getClientSnapshot(email: string) {
  const snapshot = sanitizeClientSnapshot(getBotForEmail(email).getSnapshot());
  return {
    ...snapshot,
    logs: snapshot.logs
      .filter((log) => !isPrivateDispatchLog(log.message))
      .map((log) => ({ ...log, message: presentAiTerminology(log.message) })),
    imageUsage: imageUsageStore.clientSnapshot(email)
  };
}

async function broadcastLeadersToBots() {
  const leaders = leaderStore.all();
  await Promise.all(Array.from(bots.values()).map((bot) => bot.setLeaderContacts(leaders)));
  broadcastAdminSnapshot();
}

function getMaintenanceEmails(clientEmail?: string) {
  const normalizedEmail = String(clientEmail || "").trim().toLowerCase();
  if (normalizedEmail && panelUsers.has(normalizedEmail)) return [normalizedEmail];
  return getClientEmails();
}

async function clearAdminMaintenanceData(target: string, clientEmail?: string) {
  const emails = getMaintenanceEmails(clientEmail);
  const clearLogs = target === "logs" || target === "all";
  const clearRoutes = target === "routes" || target === "all";
  const clearSupport = target === "support" || target === "all";

  if (!clearLogs && !clearRoutes && !clearSupport) {
    throw new Error("Tipo de limpeza inválido.");
  }

  if (clearLogs || clearRoutes) {
    await Promise.all(emails.map(async (email) => {
      const bot = getBotForEmail(email);
      if (clearLogs) await bot.clearLogs(true);
      if (clearRoutes) await bot.clearRouteHistory(true);
    }));
  }

  if (clearSupport) {
    const normalizedEmail = String(clientEmail || "").trim().toLowerCase();
    supportMessageStore.clear(normalizedEmail || undefined);
  }
}

let adminSnapshotBroadcastScheduled = false;
function broadcastAdminSnapshot() {
  if (!adminClients.size || adminSnapshotBroadcastScheduled) return;
  adminSnapshotBroadcastScheduled = true;
  setImmediate(() => {
    adminSnapshotBroadcastScheduled = false;
    if (!adminClients.size) return;
    try {
      handleCriticalAdminNotifications();
      const payload = `data: ${JSON.stringify(getAdminMonitorSnapshot())}\n\n`;
      for (const client of adminClients) writeStream(client, payload);
    } catch (error) {
      console.error("Falha ao gerar snapshot do painel admin:", error);
    }
  });
}

function sendClientPush(email: string, notification: Parameters<PushNotificationStore["sendToEmails"]>[1]) {
  if (panelUsers.get(email)?.blocked) return;
  void pushNotificationStore.sendToEmails([email], notification).catch((error) => console.error("Falha ao enviar notificação ao cliente:", error));
}

const financeReminderSent = new Map<string, string>();
function notifyClientsAboutUpcomingPayments() {
  const today = new Date().toISOString().slice(0, 10);
  for (const email of getClientEmails()) {
    const finance = imageUsageStore.clientSnapshot(email);
    if (!finance.billingReminder || !finance.dueDate) continue;
    const reminderKey = `${finance.dueDate.slice(0, 10)}:${today}`;
    if (financeReminderSent.get(email) === reminderKey) continue;
    financeReminderSent.set(email, reminderKey);
    sendClientPush(email, {
      title: "Lembrete de vencimento",
      body: finance.billingReminder,
      tag: `billing:${email}:${reminderKey}`,
      url: "/?tab=image"
    });
    broadcastSnapshot(email);
  }
}
const financeReminderTimer = setInterval(notifyClientsAboutUpcomingPayments, 60 * 60_000);
financeReminderTimer.unref();
setTimeout(notifyClientsAboutUpcomingPayments, 10_000).unref();

function sendAdminPush(notification: Parameters<PushNotificationStore["sendToRole"]>[1]) {
  void pushNotificationStore.sendToEmails(Array.from(panelUsers.entries()).filter(([, user]) => user.role === "admin" && !user.blocked).map(([email]) => email), notification).catch((error) => console.error("Falha ao enviar notificação ao admin:", error));
}

function handleCriticalBotNotifications(email: string, snapshot: BotSnapshot) {
  const selection = snapshot.ocrRouteSelection;
  const analysisKey = selection?.processedAt ? `${selection.status}:${selection.processedAt}` : "";
  const incident = (snapshot.routeDispatches || []).find((route) => route.clientIncident?.required && !route.clientIncident.answeredAt);
  const incidentId = incident?.id || "";
  const current = { status: snapshot.status, monitoringEnabled: Boolean(snapshot.monitoringEnabled), analysisKey, incidentId };
  const previous = lastCriticalBotState.get(email);
  lastCriticalBotState.set(email, current);
  if (!previous) return;

  if (snapshot.status === "waiting_qr" && previous.status !== "waiting_qr") {
    sendClientPush(email, { title: "WhatsApp precisa ser conectado", body: "Abra o painel e leia o QR Code para o bot voltar a funcionar.", tag: `qr:${email}`, url: "/?tab=settings", requireInteraction: true });
  }
  if ((snapshot.status === "error" || snapshot.status === "disconnected") && previous.monitoringEnabled && previous.status !== snapshot.status) {
    const notification = { title: "Bot interrompido", body: `O WhatsApp de ${email} parou durante o monitoramento. Abra o painel para reconectar.`, tag: `bot-offline:${email}`, url: "/?tab=settings", requireInteraction: true };
    sendClientPush(email, notification);
    sendAdminPush(notification);
  }
  if (analysisKey && analysisKey !== previous.analysisKey && selection?.status === "ready" && snapshot.config.ocrManualRouteSelection) {
    sendClientPush(email, { title: "Análise da IA concluída", body: "A IA cruzou a imagem com o romaneio. Escolha a rota no painel.", tag: `ia-ready:${analysisKey}`, url: "/?tab=image", requireInteraction: true });
  }
  if (analysisKey && analysisKey !== previous.analysisKey && selection?.status === "error") {
    const notification = { title: "IA precisa de atenção", body: selection.message || "A IA não conseguiu confirmar uma rota segura na imagem.", tag: `ia-error:${analysisKey}`, url: "/?tab=image", requireInteraction: true };
    sendClientPush(email, notification);
    sendAdminPush({ ...notification, body: `${email}: ${notification.body}` });
  }
  if (incidentId && incidentId !== previous.incidentId) {
    sendClientPush(email, { title: "Ação obrigatória no painel", body: incident?.clientIncident?.message || "Explique o incidente para liberar o bot.", tag: `incident:${incidentId}`, url: "/", requireInteraction: true });
  }
}

function handleCriticalAdminNotifications() {
  const pendingRoutes = getAdminRoutesSnapshot().pendingReactionRoutes;
  const currentIds = new Set(pendingRoutes.map((route) => route.id));
  if (lastAdminPendingRouteIds) {
    for (const route of pendingRoutes) {
      if (lastAdminPendingRouteIds.has(route.id)) continue;
      sendAdminPush({
        title: "Rota aguardando validação",
        body: `${route.clientEmail}: ${route.ocr?.bairro || route.ocr?.route || route.messages[0] || route.groupName}`,
        tag: `validation:${route.id}`,
        url: "/?admin=reactions",
        requireInteraction: true
      });
    }
  }
  lastAdminPendingRouteIds = currentIds;
}

const clientSnapshotBroadcastsScheduled = new Set<string>();
function broadcastSnapshot(email: string) {
  if (clientSnapshotBroadcastsScheduled.has(email)) return;
  clientSnapshotBroadcastsScheduled.add(email);
  setImmediate(() => {
    clientSnapshotBroadcastsScheduled.delete(email);
    if (![...clients].some((client) => client.email === email)) return;
    try {
      const snapshot = getClientSnapshot(email);
      const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
      for (const client of clients) {
        if (client.email === email) writeStream(client.response, payload);
      }
    } catch (error) {
      console.error("Falha ao gerar snapshot do cliente:", error);
    }
  });
}

function logSnapshot(email: string) {
  const snapshot = getBotForEmail(email).getSnapshot();
  const lastLog = snapshot.logs[0];
  const logId = lastLog?.id || "";
  const lastState = lastSnapshotState.get(email) || { qrCode: "", logId: "" };
  const shouldPrint = snapshot.qrCode !== lastState.qrCode || logId !== lastState.logId;

  if (!shouldPrint) return;
  lastSnapshotState.set(email, { qrCode: snapshot.qrCode, logId });

  console.log("------------------------------------");
  console.log("Bot WhatsApp - Render/Web");
  console.log("Usuario:", email);
  console.log("Status:", snapshot.status);
  console.log("Monitoramento:", snapshot.monitoringEnabled ? "ativado" : "desativado");
  if (snapshot.config.grupoAlvoNome || snapshot.config.grupoAlvoJid) {
    console.log("Grupo alvo:", snapshot.config.grupoAlvoNome || snapshot.config.grupoAlvoJid);
  }
  if (snapshot.error) console.log("Erro:", snapshot.error);
  if (lastLog) console.log("Ultimo log:", lastLog.message);
  if (snapshot.qrCode) {
    console.log("QR Code disponivel no painel web.");
    qrcodeTerminal.generate(snapshot.qrCode, { small: true });
  }
  console.log("------------------------------------");
}

async function handleAction(bot: BotProcessProxy, action: string, body: any) {
  for (const field of ["codes", "routes", "optionIds", "ocrDesiredCages"]) {
    if (field === "routes" && action === "save-route-preset") continue;
    const values = body[field];
    if (values !== undefined && (!Array.isArray(values) || values.length > 1000 || values.some((value) => typeof value !== "string" || value.length > 1000))) throw new HttpError(400, `Lista inválida: ${field}.`);
  }
  if (body.senderName !== undefined && (typeof body.senderName !== "string" || body.senderName.length > 200)) throw new HttpError(400, "Nome de envio inválido.");
  switch (action) {
    case "start":
      await bot.start();
      break;
    case "stop":
      await bot.stop();
      break;
    case "restart":
      await bot.restart();
      break;
    case "clear-session":
      await bot.clearSession();
      break;
    case "refresh-qr":
      await bot.refreshQrCode();
      break;
    case "factory-reset":
      await bot.factoryReset();
      break;
    case "clear-logs":
      await bot.clearLogs();
      break;
    case "refresh-groups":
      await bot.refreshGroups();
      break;
    case "start-monitoring":
      await bot.enableMonitoring();
      break;
    case "start-image-monitoring":
      await bot.enableImageMonitoring();
      break;
    case "start-nuclear-monitoring":
      await bot.enableNuclearMonitoring();
      break;
    case "start-test-monitoring":
      await bot.enableTestMonitoring();
      break;
    case "stop-monitoring":
      await bot.disableMonitoring();
      break;
    case "simulate-opening":
      await bot.simulateOpening();
      break;
    case "manual-dispatch":
      await bot.manualDispatch();
      break;
    case "simulate-target-dispatch":
      await bot.simulateTargetDispatchOnTestGroup();
      break;
    case "latency-probe":
      await bot.runLatencyProbeOnTestGroup();
      break;
    case "warmup":
      await bot.warmupConnection();
      break;
    case "save-group":
      await bot.saveGroup(String(body.group || ""), body.groupId, body.groupName);
      break;
    case "save-test-group":
      await bot.saveTestGroup(String(body.group || ""), body.groupId, body.groupName);
      break;
    case "save-codes":
      await bot.setMessageCodes(Array.isArray(body.codes) ? body.codes : []);
      break;
    case "save-message-settings":
    case "save-target-message-settings":
      await bot.setMessageSettings(
        String(body.senderName || ""),
        Array.isArray(body.codes) ? body.codes : [],
        Array.isArray(body.routes) ? body.routes : undefined,
        Array.isArray(body.monitoredRoutes) ? body.monitoredRoutes : undefined,
        body.targetDispatchMode === "ocr" ? "ocr" : body.targetDispatchMode === "manual" ? "manual" : undefined,
        body.ocrCageMessageLimit,
        body.ocrMaxStops,
        body.ocrMaxPackages,
        body.ocrRouteChoiceMode,
        body.ocrRouteChoiceMetric
      );
      break;
    case "save-warmup-message-settings":
      await bot.setWarmupMessageSettings(
        String(body.senderName || ""),
        Array.isArray(body.codes) ? body.codes : [],
        body.messageCount,
        body.intervalMs
      );
      break;
    case "save-route-preset":
      await bot.saveRoutePreset(String(body.name || ""), Array.isArray(body.routes) ? body.routes : []);
      break;
    case "delete-route-preset":
      await bot.deleteRoutePreset(String(body.id || ""));
      break;
    case "save-general-settings":
      await bot.setGeneralSettings({
        nuclearMode: Boolean(body.nuclearMode),
        alwaysWarmMode: body.alwaysWarmMode,
        keepAliveIntervalMs: body.keepAliveIntervalMs,
        ocrManualRouteSelection: body.ocrManualRouteSelection,
        ocrSelectionMode: body.ocrSelectionMode,
        ocrDesiredCages: Array.isArray(body.ocrDesiredCages) ? body.ocrDesiredCages : undefined,
        ocrCageMessageLimit: body.ocrCageMessageLimit
      });
      break;
    case "confirm-ocr-routes":
      await bot.confirmOcrRouteSelection(Array.isArray(body.optionIds) ? body.optionIds : []);
      break;
    case "submit-route-incident":
      await bot.submitClientIncident(String(body.routeId || ""), Boolean(body.valid), String(body.reason || ""));
      break;
    case "snooze-route-incident":
      await bot.snoozeClientIncident(String(body.routeId || ""));
      break;
    default:
      throw new Error(`Acao desconhecida: ${action}`);
  }

  return bot.getSnapshot();
}

function getContentType(filePath: string) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(urlPath: string, response: http.ServerResponse) {
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const requested = path.join(staticDir, safePath === "/" ? "index.html" : safePath);
  const filePath = requested.startsWith(staticDir + path.sep) && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(staticDir, "index.html");

  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("Painel web ainda nao foi compilado. Rode npm run build.");
    return;
  }

  const fileName = path.basename(filePath);
  const shouldRevalidate = fileName === "index.html" || fileName === "sw.js" || fileName === "manifest.webmanifest";
  response.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": shouldRevalidate ? "no-store, no-cache, must-revalidate" : "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
}

function getLocalAddresses() {
  const addresses: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(`http://${item.address}:${port}`);
      }
    }
  }
  return addresses;
}

function startKeepAlive() {
  if (!keepAliveUrl || process.env.KEEP_ALIVE_WHEN_MONITORING === "false") return;

  const pingUrl = `${keepAliveUrl.replace(/\/$/, "")}/api/ping`;
  console.log(`Keep-alive armado para monitoramento: ${pingUrl}`);

  setInterval(() => {
    const hasActiveMonitoring = Array.from(bots.values()).some((item) => {
      const snapshot = item.getSnapshot();
      return snapshot.monitoringEnabled && snapshot.status === "connected";
    });
    if (!hasActiveMonitoring) return;

    fetch(pingUrl, { signal: AbortSignal.timeout(15_000) })
      .then((response) => {
        if (!response.ok) {
          console.log(`Keep-alive respondeu ${response.status}.`);
        }
      })
      .catch((error) => {
        console.log(`Keep-alive falhou: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, KEEP_ALIVE_INTERVAL_MS);
}

function getNextDailyResetDelay() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DAILY_SESSION_RESET_HOUR, DAILY_SESSION_RESET_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function startDailySessionReset() {
  if (!DAILY_SESSION_RESET_ENABLED) {
    console.log("Reset diário de conexões desativado; sessões permanecerão aquecidas.");
    return;
  }

  const scheduleNext = () => {
    const delay = getNextDailyResetDelay();
    const nextRun = new Date(Date.now() + delay).toLocaleString("pt-BR", { timeZone: "America/Belem" });
    console.log(`Reset diário de segurança agendado para: ${nextRun}`);

    setTimeout(async () => {
      console.log("Reset diário: renovando conexões e restaurando monitoramentos ativos.");
      await Promise.all(Array.from(bots.values()).map(async (bot) => {
        if (bot.getSnapshot().status === "disconnected") return;
        await bot.restart().catch(() => undefined);
      }));
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.method === "GET" && url.pathname === "/api/ping") {
      sendJson(response, 200, { ok: true, protected: Boolean(panelUsers.size), login: "email" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/support/messages") {
      if (!supportLimiter.allow(request.socket.remoteAddress || "unknown")) throw new HttpError(429, "Aguarde um minuto antes de enviar outra mensagem.");
      const body = await readJsonBody(request);
      const message = supportMessageStore.create({
        email: String(body.email || ""),
        message: String(body.message || ""),
        userAgent: String(request.headers["user-agent"] || "")
      });
      sendAdminPush({
        title: "Nova mensagem de suporte",
        body: `${message.email}: ${message.message.slice(0, 180)}`,
        tag: `support:${message.id}`,
        url: "/?admin=support",
        requireInteraction: true
      });
      broadcastAdminSnapshot();
      sendJson(response, 200, { ok: true, message });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!loginLimiter.allow(request.socket.remoteAddress || "unknown")) throw new HttpError(429, "Muitas tentativas. Aguarde cinco minutos.");
      const body = await readJsonBody(request);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (email.length > 254 || password.length > 1024) throw new HttpError(400, "Email ou senha inválidos.");
      if (!accountLoginLimiter.allow(email)) throw new HttpError(429, "Muitas tentativas. Aguarde cinco minutos.");
      if (!panelUsers.size) {
        sendJson(response, 503, { error: "Configure PANEL_USERS no Render para liberar o login." });
        return;
      }
      const expectedPassword = panelUsers.get(email);
      if (!email || !expectedPassword || !isEmailAllowedOnThisService(email) || !await verifyPassword(password, expectedPassword.password)) {
        sendJson(response, 401, { error: "Email ou senha invalidos." });
        return;
      }
      if (panelUsers.get(email) !== expectedPassword) throw new HttpError(401, "Login obrigatório.");
      if (expectedPassword.blocked) {
        sendJson(response, 403, { error: "Usuário bloqueado pelo administrador." });
        return;
      }

      const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = String(request.headers["user-agent"] || "");
      panelUserStore.upsert({
        email,
        password: expectedPassword.password,
        role: expectedPassword.role,
        blocked: expectedPassword.blocked,
        color: expectedPassword.color,
        source: expectedPassword.source || "environment"
      });
      panelUserStore.recordLogin(email, ip, userAgent);
      syncPanelUser(panelUserStore.all().find((user) => user.email === email)!);

      sendJson(response, 200, {
        ok: true,
        token: createSessionToken(email),
        user: { email, role: expectedPassword.role, blocked: expectedPassword.blocked, color: expectedPassword.color }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/events") {
      const email = getAuthorizedEmailFromUrl(url);
      if (!email) { sendJson(response, 401, { error: "Login obrigatório." }); return; }
      if (!requireAdmin(email, response)) return;

      registerStream(response, url, email);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive"
      });
      response.flushHeaders?.();
      adminClients.add(response);
      writeStream(response, `data: ${JSON.stringify(getAdminMonitorSnapshot())}\n\n`);
      request.on("close", () => adminClients.delete(response));
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const email = getAuthorizedEmailFromUrl(url);
      if (!email) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Login obrigatório." }));
        return;
      }
      touchPanelUser(email);
      const activeBot = getBotForEmail(email);
      registerStream(response, url, email);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive"
      });
      response.flushHeaders?.();
      const client = { email, response };
      clients.add(client);
      writeStream(response, `data: ${JSON.stringify(getClientSnapshot(email))}\n\n`);
      request.on("close", () => clients.delete(client));
      return;
    }

    let authorizedEmail = "";
    if (url.pathname.startsWith("/api/") || url.pathname === "/qr.svg") {
      const email = requireAuth(request, response);
      if (!email) return;
      authorizedEmail = email;
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      const session = getSessionClaims(request);
      sendJson(response, 200, {
        email: authorizedEmail,
        role: getUserRole(authorizedEmail),
        blocked: panelUsers.get(authorizedEmail)?.blocked,
        color: panelUsers.get(authorizedEmail)?.color,
        impersonatedBy: session?.email === authorizedEmail ? session.impersonatedBy : undefined
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/cloud-backup/restore") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ confirmation?: string; sourceKey?: string }>(request);
      if (body.confirmation !== "RESTAURAR DADOS") {
        sendJson(response, 400, { error: "ConfirmaÃ§Ã£o invÃ¡lida. A restauraÃ§Ã£o nÃ£o foi iniciada." });
        return;
      }
      if (!getCloudBackupStatus().configured) {
        sendJson(response, 503, { error: "Configure as variÃ¡veis do R2 neste serviÃ§o antes de restaurar." });
        return;
      }
      if (!body.sourceKey) {
        sendJson(response, 400, { error: "Selecione qual snapshot deseja restaurar." });
        return;
      }
      const preparedRestore = await prepareCloudRestore(dataDir, body.sourceKey);
      sendJson(response, 202, {
        accepted: true,
        sourceKey: preparedRestore.sourceKey,
        message: `Backup ${preparedRestore.sourceKey} validado. O serviÃ§o serÃ¡ pausado brevemente e reiniciado com os dados restaurados.`
      });
      setTimeout(() => {
        void shutdown(async () => {
          setCloudRestoreStatus(dataDir, { phase: "applying", message: "Servidor parando os bots para aplicar os dados...", sourceKey: preparedRestore.sourceKey, progress: 93 });
          await applyPreparedCloudRestore(dataDir, preparedRestore.stageDir);
        });
      }, 100);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/portable-backup/export") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const passphrase = String(request.headers["x-backup-passphrase"] || "");
      if (passphrase.length < 12 || passphrase.length > 1024) {
        sendJson(response, 400, { error: "Escolha uma senha com pelo menos 12 caracteres para proteger o arquivo." });
        return;
      }
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rota-mind-portable-"));
      const archivePath = path.join(tempDir, "bot-rotas.botbackup");
      try {
        await createPortableEncryptedArchive(dataDir, archivePath, passphrase);
        const stat = await fs.promises.stat(archivePath);
        response.writeHead(200, {
          "Content-Type": "application/vnd.rota-mind.portable-backup",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="bot-rotas-${new Date().toISOString().slice(0, 10)}.botbackup"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        await pipeline(fs.createReadStream(archivePath), response);
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/portable-backup/preview") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const passphrase = String(request.headers["x-backup-passphrase"] || "");
      if (passphrase.length < 12 || passphrase.length > 1024) {
        sendJson(response, 400, { error: "Digite a senha usada quando o arquivo foi exportado (mínimo de 12 caracteres)." });
        return;
      }
      for (const [ticketId, ticket] of portableRestoreTickets) {
        if (Date.now() - ticket.createdAt > 30 * 60_000) {
          portableRestoreTickets.delete(ticketId);
          await fs.promises.rm(ticket.stageDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (portableRestoreTickets.size) {
        sendJson(response, 409, { error: "Já existe uma restauração portátil aguardando confirmação neste servidor." });
        return;
      }
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rota-mind-upload-"));
      const archivePath = path.join(tempDir, "upload.botbackup");
      const stageDir = path.join(dataDir, `.cloud-restore-stage-${crypto.randomUUID()}`);
      try {
        await savePortableUpload(request, archivePath);
        await fs.promises.mkdir(stageDir, { mode: 0o700 });
        await extractEncryptedArchive(archivePath, stageDir, passphrase);
        const summary = countPortableRestoreFiles(stageDir);
        const ticket = crypto.randomUUID();
        portableRestoreTickets.set(ticket, { stageDir, createdAt: Date.now() });
        setCloudRestoreStatus(dataDir, {
          phase: "ready",
          sourceKey: "Arquivo portátil do iPhone/Arquivos",
          message: "Arquivo conferido e íntegro. Revise o resumo antes de aplicar.",
          progress: 90,
          startedAt: new Date().toISOString()
        });
        sendJson(response, 200, { ticket, summary, message: "Arquivo válido. Os dados atuais só serão substituídos após sua confirmação." });
      } catch (error) {
        await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/portable-backup/apply") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ ticket?: string; confirmation?: string }>(request);
      const pending = body.ticket ? portableRestoreTickets.get(body.ticket) : undefined;
      if (!pending || Date.now() - pending.createdAt > 30 * 60_000) {
        if (pending) await fs.promises.rm(pending.stageDir, { recursive: true, force: true }).catch(() => undefined);
        if (body.ticket) portableRestoreTickets.delete(body.ticket);
        sendJson(response, 410, { error: "A prévia expirou. Selecione o arquivo novamente." });
        return;
      }
      if (body.confirmation !== "IMPORTAR DADOS") {
        sendJson(response, 400, { error: "Confirmação inválida. Nenhum dado foi alterado." });
        return;
      }
      portableRestoreTickets.delete(body.ticket!);
      setCloudRestoreStatus(dataDir, {
        phase: "ready",
        sourceKey: "Arquivo portátil do iPhone/Arquivos",
        message: "Restauração confirmada. O serviço vai reiniciar para aplicar os dados.",
        progress: 92
      });
      sendJson(response, 202, { accepted: true, message: "Arquivo validado. O serviço vai reiniciar e carregar os dados." });
      setTimeout(() => {
        void shutdown(async () => {
          setCloudRestoreStatus(dataDir, { phase: "applying", message: "Aplicando o arquivo portátil...", sourceKey: "Arquivo portátil", progress: 95 });
          await applyPreparedCloudRestore(dataDir, pending.stageDir);
        });
      }, 100);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/cloud-backup/objects") {
      if (!requireAdmin(authorizedEmail, response)) return;
      if (!getCloudBackupStatus().configured) {
        sendJson(response, 503, { error: "Configure as variáveis do R2 neste serviço antes de listar os backups." });
        return;
      }
      sendJson(response, 200, { objects: await listCloudBackupObjects() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/cloud-backup/restore-status") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, getCloudRestoreStatus(dataDir));
      return;
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/admin/cloud-backup") {
      if (!requireAdmin(authorizedEmail, response)) return;
      if (request.method === "GET") {
        sendJson(response, 200, getCloudBackupStatus());
        return;
      }
      if (!getCloudBackupStatus().configured) {
        sendJson(response, 503, { error: "Configure as variáveis do backup no ambiente do servidor." });
        return;
      }
      void runCloudBackup(dataDir).catch(() => undefined);
      sendJson(response, 202, { accepted: true, status: getCloudBackupStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      const session = getSessionClaims(request)!;
      for (const [id, expires] of revokedSessions) if (expires <= Date.now()) revokedSessions.delete(id);
      revokedSessions.set(session.id, session.exp);
      writeJsonAtomic(revokedSessionsPath, Array.from(revokedSessions));
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/impersonation/return") {
      const session = getSessionClaims(request);
      const adminEmail = session?.impersonatedBy;
      const admin = adminEmail ? panelUsers.get(adminEmail) : undefined;
      if (!session || session.email !== authorizedEmail || !adminEmail || admin?.role !== "admin" || admin.blocked) {
        sendJson(response, 403, { error: "Esta sessão não está no modo cliente de teste." });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        token: createSessionToken(adminEmail),
        user: { email: adminEmail, role: admin.role, blocked: admin.blocked, color: admin.color }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/release") {
      const user = panelUsers.get(authorizedEmail);
      const showToRole = user?.role === "admin" || shouldShowCurrentReleaseToClients();
      sendJson(response, 200, {
        release: currentRelease,
        shouldShow: Boolean(user && showToRole && user.lastSeenReleaseId !== currentRelease.id)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/release/acknowledge") {
      const body = await readJsonBody<{ releaseId?: string }>(request);
      const releaseId = String(body.releaseId || "").trim();
      if (releaseId !== currentRelease.id) {
        sendJson(response, 409, { error: "Uma versão mais nova já está disponível. Atualize o painel." });
        return;
      }

      const updatedUser = panelUserStore.acknowledgeRelease(authorizedEmail, releaseId);
      if (!updatedUser) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return;
      }
      syncPanelUser(updatedUser);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/push/config") {
      sendJson(response, 200, { publicKey: pushNotificationStore.publicKey() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/push/subscribe") {
      const body = await readJsonBody<{ subscription?: { endpoint?: string; expirationTime?: number | null; keys?: { p256dh?: string; auth?: string } } }>(request);
      try {
        const subscription = body.subscription;
        pushNotificationStore.upsert(authorizedEmail, getUserRole(authorizedEmail), {
          endpoint: String(subscription?.endpoint || ""),
          expirationTime: subscription?.expirationTime ?? null,
          keys: { p256dh: String(subscription?.keys?.p256dh || ""), auth: String(subscription?.keys?.auth || "") }
        });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Não foi possível ativar notificações." });
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/push/subscribe") {
      const body = await readJsonBody<{ endpoint?: string }>(request);
      pushNotificationStore.remove(String(body.endpoint || ""), authorizedEmail);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/routes") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, getAdminRoutesSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/monitor") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, getAdminMonitorSnapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/image-usage/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ decision?: string; amountCents?: number; note?: string }>(request);
      const id = decodeURIComponent(url.pathname.replace("/api/admin/image-usage/", ""));
      if (body.amountCents !== undefined) validateAmount(body.amountCents);
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 5000)) throw new HttpError(400, "Observação inválida.");
      const decision = body.decision === "billable" || body.decision === "excluded" || body.decision === "pending" ? body.decision : undefined;
      if (!decision || !imageUsageStore.decide(id, decision, authorizedEmail, body.amountCents, body.note)) {
        sendJson(response, 404, { error: "Análise não encontrada ou decisão inválida." });
        return;
      }
      const decidedEntry = imageUsageStore.get(id);
      const linkedRoute = decidedEntry ? findRouteForImageUsage(decidedEntry) : undefined;
      if (linkedRoute && decision === "billable") await validateAdminRoute(linkedRoute.id, authorizedEmail);
      if (linkedRoute && decision === "excluded") await rejectAdminRoute(linkedRoute.id, authorizedEmail, body.note || "Análise de imagem excluída manualmente pelo admin.");
      broadcastAdminSnapshot();
      const entry = imageUsageStore.snapshot().entries.find((item) => item.id === id);
      if (entry) broadcastSnapshot(entry.clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/image-pricing/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const clientEmail = decodeURIComponent(url.pathname.replace("/api/admin/image-pricing/", "")).trim().toLowerCase();
      const body = await readJsonBody<{ amountCents?: number }>(request);
      if (!panelUsers.has(clientEmail) || !Number.isSafeInteger(body.amountCents) || Number(body.amountCents) < 0 || Number(body.amountCents) > 10_000_000) {
        sendJson(response, 400, { error: "Cliente ou valor inválido." });
        return;
      }
      imageUsageStore.setDefaultAmount(clientEmail, Number(body.amountCents));
      broadcastAdminSnapshot();
      broadcastSnapshot(clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/image-total/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const clientEmail = decodeURIComponent(url.pathname.replace("/api/admin/image-total/", "")).trim().toLowerCase();
      const body = await readJsonBody<{ amountCents?: number; month?: string }>(request);
      if (!panelUsers.has(clientEmail) || !Number.isSafeInteger(body.amountCents) || Number(body.amountCents) < 0 || Number(body.amountCents) > 10_000_000) {
        sendJson(response, 400, { error: "Cliente ou valor total inválido." });
        return;
      }
      if (body.month !== undefined && (typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month))) throw new HttpError(400, "Mês inválido.");
      imageUsageStore.setMonthlyTotal(clientEmail, Number(body.amountCents), typeof body.month === "string" ? body.month : undefined);
      broadcastAdminSnapshot();
      broadcastSnapshot(clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/route-billing/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const clientEmail = decodeURIComponent(url.pathname.replace("/api/admin/route-billing/", "")).trim().toLowerCase();
      const body = await readJsonBody<{ enabled?: boolean }>(request);
      if (!panelUsers.has(clientEmail) || typeof body.enabled !== "boolean") {
        sendJson(response, 400, { error: "Cliente ou controle de cobranÃ§a invÃ¡lido." });
        return;
      }
      imageUsageStore.setBillAllValidatedRoutes(clientEmail, true);
      for (const route of getBotForEmail(clientEmail).getRoutes().filter((item) => item.validated)) {
        approveRouteImageUsage(route, clientEmail, authorizedEmail);
      }
      broadcastAdminSnapshot();
      broadcastSnapshot(clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/client-finance/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const clientEmail = decodeURIComponent(url.pathname.replace("/api/admin/client-finance/", "")).trim().toLowerCase();
      const body = await readJsonBody<{ routePriceCents?: number; dueDay?: number; addPrepaidRoutes?: number; prepaidRoutesRemaining?: number; paymentEveryRoutes?: number }>(request);
      if (!panelUsers.has(clientEmail)) throw new HttpError(404, "Cliente nÃ£o encontrado.");
      if (body.routePriceCents !== undefined) {
        if (!Number.isSafeInteger(body.routePriceCents) || body.routePriceCents < 0 || body.routePriceCents > 10_000_000) throw new HttpError(400, "Valor por rota invÃ¡lido.");
        imageUsageStore.setRoutePrice(clientEmail, body.routePriceCents);
      }
      if (body.dueDay !== undefined) {
        if (!Number.isInteger(body.dueDay) || body.dueDay < 1 || body.dueDay > 31) throw new HttpError(400, "O vencimento deve ser entre os dias 1 e 31.");
        imageUsageStore.setDueDay(clientEmail, body.dueDay);
      }
      if (body.addPrepaidRoutes !== undefined) {
        if (!Number.isInteger(body.addPrepaidRoutes) || body.addPrepaidRoutes < 1 || body.addPrepaidRoutes > 10_000) throw new HttpError(400, "Quantidade de rotas prÃ©-pagas invÃ¡lida.");
        imageUsageStore.addPrepaidRoutes(clientEmail, body.addPrepaidRoutes);
      }
      if (body.prepaidRoutesRemaining !== undefined) {
        if (!Number.isInteger(body.prepaidRoutesRemaining) || body.prepaidRoutesRemaining < 0 || body.prepaidRoutesRemaining > 10_000) throw new HttpError(400, "Quantidade de rotas antecipadas inválida.");
        imageUsageStore.setPrepaidRoutes(clientEmail, body.prepaidRoutesRemaining);
      }
      if (body.paymentEveryRoutes !== undefined) {
        if (!Number.isInteger(body.paymentEveryRoutes) || body.paymentEveryRoutes < 0 || body.paymentEveryRoutes > 10_000) throw new HttpError(400, "A quantidade de rotas por ciclo deve ser entre 0 e 10000.");
        imageUsageStore.setPaymentEveryRoutes(clientEmail, body.paymentEveryRoutes);
      }
      broadcastAdminSnapshot();
      broadcastSnapshot(clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/admin/client-payment/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const clientEmail = decodeURIComponent(url.pathname.replace("/api/admin/client-payment/", "")).trim().toLowerCase();
      if (!panelUsers.has(clientEmail)) throw new HttpError(404, "Cliente nÃ£o encontrado.");
      imageUsageStore.registerPayment(clientEmail);
      broadcastAdminSnapshot();
      broadcastSnapshot(clientEmail);
      sendJson(response, 200, imageUsageStore.snapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/maintenance/clear") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ target?: string; clientEmail?: string }>(request);
      await clearAdminMaintenanceData(String(body.target || ""), body.clientEmail);
      broadcastAdminSnapshot();
      sendJson(response, 200, getAdminMonitorSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/impersonate") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ email?: string }>(request);
      const clientEmail = String(body.email || "").trim().toLowerCase();
      const client = panelUsers.get(clientEmail);
      if (!client || client.role !== "client") {
        sendJson(response, 404, { error: "Usuário cliente não encontrado." });
        return;
      }
      if (client.blocked) {
        sendJson(response, 409, { error: "Desbloqueie o usuário de teste antes de entrar no modo cliente." });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        token: createSessionToken(clientEmail, authorizedEmail),
        user: {
          email: clientEmail,
          role: client.role,
          blocked: client.blocked,
          color: client.color,
          impersonatedBy: authorizedEmail
        }
      });
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/routes/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ reason?: string }>(request).catch((): { reason?: string } => ({}));
      const isValidate = url.pathname.endsWith("/validate");
      const isReject = url.pathname.endsWith("/reject");
      const routeId = decodeURIComponent(url.pathname.replace("/api/admin/routes/", "").replace(/\/validate$/, "").replace(/\/reject$/, ""));
      const changed = isValidate
        ? await validateAdminRoute(routeId, authorizedEmail)
        : isReject
        ? await rejectAdminRoute(routeId, authorizedEmail, body.reason)
        : false;
      if (!changed) {
        sendJson(response, 404, { error: "Rota não encontrada." });
        return;
      }
      broadcastAdminSnapshot();
      sendJson(response, 200, getAdminRoutesSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/routes/bulk") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ routeIds?: string[]; decision?: string; reason?: string }>(request);
      const routeIds = Array.isArray(body.routeIds) ? body.routeIds.filter((item) => typeof item === "string" && item.trim()) : [];
      const decision = body.decision === "reject" ? "reject" : body.decision === "validate" ? "validate" : undefined;
      if (!routeIds.length || !decision) {
        sendJson(response, 400, { error: "Informe routeIds e decision." });
        return;
      }
      const changed = await bulkDecideAdminRoutes(routeIds, authorizedEmail, decision, body.reason);
      broadcastAdminSnapshot();
      sendJson(response, 200, { ...getAdminRoutesSnapshot(), changed });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/users") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, getAdminUsersSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/support/messages") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, getAdminSupportMessagesSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/leaders") {
      if (!requireAdmin(authorizedEmail, response)) return;
      sendJson(response, 200, { leaders: leaderStore.all() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/leaders") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody<{ name?: string; phone?: string }>(request);
      leaderStore.upsert({ name: String(body.name || ""), phone: String(body.phone || "") });
      await broadcastLeadersToBots();
      sendJson(response, 200, { leaders: leaderStore.all() });
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/leaders/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const phone = decodeURIComponent(url.pathname.replace("/api/admin/leaders/", ""));
      leaderStore.remove(phone);
      await broadcastLeadersToBots();
      sendJson(response, 200, { leaders: leaderStore.all() });
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/support/messages/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const id = decodeURIComponent(url.pathname.replace("/api/admin/support/messages/", ""));
      supportMessageStore.markRead(id);
      broadcastAdminSnapshot();
      sendJson(response, 200, getAdminSupportMessagesSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/admin/users/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const email = decodeURIComponent(url.pathname.replace("/api/admin/users/", ""));
      const detail = getAdminUserDetail(email);
      if (!detail) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return;
      }
      sendJson(response, 200, detail);
      return;
    }

    if (request.method === "POST" && url.pathname.includes("/action/") && url.pathname.startsWith("/api/admin/users/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const [, encodedEmail = "", action = ""] = url.pathname.match(/^\/api\/admin\/users\/(.+)\/action\/([^/]+)$/) || [];
      const targetEmail = decodeURIComponent(encodedEmail).trim().toLowerCase();
      if (!panelUsers.has(targetEmail)) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return;
      }
      const body = await readJsonBody(request);
      await handleAction(getBotForEmail(targetEmail), decodeURIComponent(action), body);
      broadcastAdminSnapshot();
      sendJson(response, 200, getAdminUserDetail(targetEmail));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/users") {
      if (!requireAdmin(authorizedEmail, response)) return;
      const body = await readJsonBody(request);
      const newEmail = validateEmail(body.email);
      if (panelUsers.has(newEmail)) throw new HttpError(409, "Email já cadastrado. Use a edição do usuário.");
      assertUniqueStorageKey(newEmail);
      if (typeof body.password !== "string" || !body.password.trim() || body.password.length > 1024) throw new HttpError(400, "Informe uma senha válida com até 1024 caracteres.");
      const user = panelUserStore.upsert({
        email: newEmail,
        password: String(body.password || ""),
        role: body.role === "admin" ? "admin" : "client",
        blocked: Boolean(body.blocked),
        color: normalizeUserColor(String(body.color || ""), String(body.email || "")),
        dispatchPriorityLevel: 0,
        dispatchBeatsEmail: normalizeDispatchBeatsEmail(body.dispatchBeatsEmail, String(body.email || "")),
        dispatchAdvantageMs: normalizeDispatchAdvantageMs(body.dispatchAdvantageMs),
        dispatchMatchups: normalizeDispatchMatchups(body.dispatchMatchups, String(body.email || ""))
      });
      syncPanelUser(user);
      appliedConditionalPriority.delete(user.email);
      scheduleConditionalPrioritySync();
      sendJson(response, 200, getAdminUsersSnapshot());
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/admin/users/")) {
      if (!requireAdmin(authorizedEmail, response)) return;
      const targetEmail = decodeURIComponent(url.pathname.replace("/api/admin/users/", "")).trim().toLowerCase();
      if (!panelUsers.has(targetEmail)) {
        sendJson(response, 404, { error: "Usuário não encontrado." });
        return;
      }
      const body = await readJsonBody(request);
      const nextEmail = validateEmail(body.email ?? targetEmail);
      const currentUser = panelUsers.get(targetEmail)!;
      if (nextEmail !== targetEmail && panelUsers.has(nextEmail)) throw new HttpError(409, "Email já cadastrado.");
      assertUniqueStorageKey(nextEmail, targetEmail);
      if (body.password !== undefined && (typeof body.password !== "string" || body.password.length > 1024)) throw new HttpError(400, "Senha inválida.");
      const nextRole = body.role === undefined ? currentUser.role : body.role === "admin" ? "admin" : "client";
      const nextBlocked = body.blocked === undefined ? currentUser.blocked : Boolean(body.blocked);
      if (currentUser.role === "admin" && (nextRole !== "admin" || nextBlocked) && !Array.from(panelUsers.entries()).some(([email, user]) => email !== targetEmail && user.role === "admin" && !user.blocked)) {
        throw new HttpError(400, "Mantenha ao menos um administrador ativo.");
      }

      if (nextEmail !== targetEmail) {
        if (!panelUserStore.all().some((user) => user.email === targetEmail)) panelUserStore.upsert({ email: targetEmail, password: currentUser.password, role: currentUser.role, blocked: currentUser.blocked, color: currentUser.color, source: currentUser.source || "environment" });
        await renameUserStorage(targetEmail, nextEmail);
        panelUserStore.rename(targetEmail, nextEmail);
        imageUsageStore.renameClientEmail(targetEmail, nextEmail);
        panelUsers.delete(targetEmail);
      }

      const user = panelUserStore.upsert({
        email: nextEmail,
        password: typeof body.password === "string" && body.password.trim() ? body.password : currentUser.password,
        role: nextRole,
        blocked: nextBlocked,
        source: "panel",
        color: normalizeUserColor(String(body.color || currentUser.color || ""), nextEmail),
        dispatchPriorityLevel: currentUser.dispatchPriorityLevel,
        dispatchBeatsEmail: normalizeDispatchBeatsEmail(body.dispatchBeatsEmail ?? currentUser.dispatchBeatsEmail, nextEmail),
        dispatchAdvantageMs: normalizeDispatchAdvantageMs(body.dispatchAdvantageMs ?? currentUser.dispatchAdvantageMs),
        dispatchMatchups: normalizeDispatchMatchups(body.dispatchMatchups ?? currentUser.dispatchMatchups, nextEmail)
      });
      syncPanelUser(user);
      appliedConditionalPriority.delete(user.email);
      scheduleConditionalPrioritySync();
      sendJson(response, 200, getAdminUsersSnapshot());
      return;
    }

    const activeBot = authorizedEmail ? getBotForEmail(authorizedEmail) : undefined;
    const activeRomaneio = authorizedEmail ? getRomaneioStoreForEmail(authorizedEmail) : undefined;

    if (request.method === "POST" && url.pathname === "/api/romaneio/upload") {
      try {
        const file = await readMultipartFile(request);
        const snapshot = activeRomaneio!.saveUpload(file.fileName, file.buffer);
        console.log(`[ROMANEIO] ${authorizedEmail} enviou ${file.fileName}: ${snapshot.status.totalRows} linhas, ${snapshot.status.totalRoutes} rotas, ${snapshot.status.totalPackages} pacotes.`);
        sendJson(response, 200, snapshot);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Não foi possível processar o romaneio." });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/romaneio/clear") {
      const snapshot = activeRomaneio!.clear();
      console.log(`[ROMANEIO] ${authorizedEmail} limpou o romaneio carregado.`);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/romaneio/locate") {
      sendJson(response, 200, await activeBot!.locateRomaneioInGroup());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/romaneio/confirm") {
      const body = await readJsonBody<{ candidateId?: string }>(request);
      try {
        sendJson(response, 200, await activeBot!.confirmRomaneioCandidate(String(body.candidateId || "")));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Não foi possível confirmar o romaneio." });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/romaneio/status") {
      sendJson(response, 200, activeRomaneio!.status());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/romaneio/routes") {
      sendJson(response, 200, activeRomaneio!.all());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/romaneio/routes/search") {
      const bairro = String(url.searchParams.get("bairro") || "");
      sendJson(response, 200, { routes: activeRomaneio!.searchByNeighborhood(bairro).slice(0, 20) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/romaneio/settings") {
      sendJson(response, 200, activeRomaneio!.getSettings());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/romaneio/settings") {
      const body = await readJsonBody(request);
      sendJson(response, 200, activeRomaneio!.saveSettings(body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, getClientSnapshot(authorizedEmail));
      return;
    }

    if (request.method === "GET" && url.pathname === "/qr.svg") {
      const snapshot = activeBot!.getSnapshot();
      if (!snapshot.qrCode) {
        response.writeHead(404);
        response.end("QR indisponivel");
        return;
      }

      const svg = await QRCode.toString(snapshot.qrCode, {
        type: "svg",
        width: 400,
        margin: 4,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" }
      });
      response.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store"
      });
      response.end(svg);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/action/")) {
      const action = decodeURIComponent(url.pathname.replace("/api/action/", ""));
      const body = await readJsonBody(request);
      const activeUser = authorizedEmail ? panelUsers.get(authorizedEmail) : undefined;
      const incidentActions = new Set(["submit-route-incident", "snooze-route-incident"]);
      if (activeUser?.role !== "admin" && !incidentActions.has(action) && activeBot!.hasPendingClientIncident()) {
        sendJson(response, 423, { error: "Explique o incidente pendente antes de usar o bot." });
        return;
      }
      await handleAction(activeBot!, action, body);
      sendJson(response, 200, getClientSnapshot(authorizedEmail));
      return;
    }

    if (request.method === "GET") {
      serveStatic(url.pathname, response);
      return;
    }

    response.writeHead(405);
    response.end("Method not allowed");
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
    if (status === 413 || status === 408) response.setHeader("Connection", "close");
    sendJson(response, status, { error: error instanceof Error ? error.message : "Não foi possível concluir a operação." });
  }
});

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(`Painel web: http://localhost:${typeof address === "object" && address ? address.port : port}`);
  for (const address of getLocalAddresses()) {
    console.log(`Na rede local: ${address}`);
  }
  console.log(`Dados persistentes: ${dataDir}`);
  if (!panelUsers.size) {
    console.log("Aviso: defina PANEL_USERS e PANEL_ADMIN_EMAILS no Render para liberar e proteger o painel publico.");
  }
  startKeepAlive();
  startDailySessionReset();
  startCloudBackup(dataDir);
  void preloadClientWorkers().catch((error) => {
    console.error(`Falha no pré-carregamento dos workers: ${error instanceof Error ? error.message : String(error)}`);
  });
});

let shuttingDown = false;
async function shutdown(afterStop?: () => Promise<void>) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(streamHeartbeat);
  for (const response of streamAuth.keys()) response.end();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  console.log("Encerrando painel e bots...");
  stopCloudBackup();
  server.close(() => {
    void (async () => {
      try {
        await Promise.all(Array.from(bots.values()).map((item) => item.shutdown().catch(() => undefined)));
        if (afterStop) await afterStop();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        console.error(`[BACKUP] RestauraÃ§Ã£o nÃ£o concluÃ­da: ${error instanceof Error ? error.message : String(error)}`);
        clearTimeout(deadline);
        process.exit(1);
      }
    })();
  });
  server.closeIdleConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
