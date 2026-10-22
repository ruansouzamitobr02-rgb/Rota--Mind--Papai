import {
  AdminRoutesSnapshot,
  AdminMonitorSnapshot,
  AdminImageUsageSnapshot,
  AdminSupportMessagesSnapshot,
  AdminUserDetail,
  AdminUsersSnapshot,
  BotSnapshot,
  DesktopApi,
  GeneralSettingsPayload,
  LeaderContact,
  PanelUser,
  PanelUserRole,
  ReleaseNotice,
  RomaneioLocateResult,
  RomaneioSettings,
  RomaneioSnapshot,
  SaveCodesPayload,
  SaveGroupPayload,
  SaveMessageSettingsPayload,
  SaveTargetMessageSettingsPayload,
  SaveWarmupMessageSettingsPayload
} from "../../shared/types";
import { subscribeSnapshots } from "./snapshotSubscription";
import { parseClientSnapshot } from "./clientSnapshot";

export const PANEL_SESSION_CHANGED = "panel-session-changed";

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const AUTH_ERROR_MESSAGES = [
  "Senha do painel obrigatória.",
  "Login obrigatório.",
  "Email ou senha inválidos.",
  "Email ou senha invalidos.",
  "Usuário bloqueado pelo administrador.",
  "Acesso bloqueado. Fale com o suporte para liberar sua conta."
];

export function getPanelPassword() {
  return window.localStorage.getItem("panelPassword") || "";
}

export function setPanelPassword(password: string) {
  if (password) {
    window.localStorage.setItem("panelPassword", password);
  } else {
    window.localStorage.removeItem("panelPassword");
  }
}

export function getPanelToken() {
  return window.localStorage.getItem("panelToken") || "";
}

export function setPanelToken(token: string) {
  const previous = getPanelToken();
  if (token) {
    window.localStorage.setItem("panelToken", token);
  } else {
    window.localStorage.removeItem("panelToken");
  }
  if (token !== previous) window.dispatchEvent(new Event(PANEL_SESSION_CHANGED));
}

export function getPanelUserEmail() {
  return window.localStorage.getItem("panelUserEmail") || "";
}

export function setPanelUserEmail(email: string) {
  if (email) {
    window.localStorage.setItem("panelUserEmail", email);
  } else {
    window.localStorage.removeItem("panelUserEmail");
  }
}

export function getPanelUserRole(): PanelUserRole {
  return window.localStorage.getItem("panelUserRole") === "admin" ? "admin" : "client";
}

export function setPanelUserRole(role: PanelUserRole | "") {
  if (role) {
    window.localStorage.setItem("panelUserRole", role);
  } else {
    window.localStorage.removeItem("panelUserRole");
  }
}

export function isAuthError(error: unknown) {
  return error instanceof ApiError && error.status === 401 || error instanceof Error && AUTH_ERROR_MESSAGES.includes(error.message);
}

export async function panelLogin(email: string, password: string) {
  const response = await fetchJson<{ token: string; user: PanelUser }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  setPanelToken(response.token);
  setPanelUserEmail(response.user.email);
  setPanelUserRole(response.user.role);
  setPanelPassword("");
  return response.user;
}

export async function revokePanelSession() {
  const token = getPanelToken();
  if (!token || window.botApi) return;
  const response = await fetch("/api/logout", { method: "POST", headers: { "x-panel-token": token }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok && response.status !== 401) throw new Error("Não foi possível encerrar a sessão no servidor.");
}

export async function getPanelMe() {
  const user = await fetchJson<PanelUser>("/api/me");
  setPanelUserEmail(user.email);
  setPanelUserRole(user.role);
  return user;
}

export async function enterClientMode(email: string) {
  const response = await fetchJson<{ token: string; user: PanelUser }>("/api/admin/impersonate", {
    method: "POST",
    body: JSON.stringify({ email })
  });
  setPanelToken(response.token);
  setPanelUserEmail(response.user.email);
  setPanelUserRole(response.user.role);
  return response.user;
}

export async function returnToAdminMode() {
  const response = await fetchJson<{ token: string; user: PanelUser }>("/api/impersonation/return", {
    method: "POST",
    body: "{}"
  });
  setPanelToken(response.token);
  setPanelUserEmail(response.user.email);
  setPanelUserRole(response.user.role);
  return response.user;
}

export function getReleaseNotice() {
  return fetchJson<ReleaseNotice>("/api/release");
}

export function acknowledgeRelease(releaseId: string) {
  return fetchJson<{ ok: boolean }>("/api/release/acknowledge", {
    method: "POST",
    body: JSON.stringify({ releaseId })
  });
}

export function getPushConfig() {
  return fetchJson<{ publicKey: string }>("/api/push/config");
}

export function savePushSubscription(subscription: PushSubscriptionJSON) {
  return fetchJson<{ ok: boolean }>("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription })
  });
}

export function removePushSubscription(endpoint: string) {
  return fetchJson<{ ok: boolean }>("/api/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint })
  });
}

export function getAdminRoutes() {
  return fetchJson<AdminRoutesSnapshot>("/api/admin/routes");
}

export function getAdminMonitor() {
  return fetchJson<AdminMonitorSnapshot>("/api/admin/monitor");
}

export type AdminCloudBackupStatus = {
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

export type AdminCloudBackupObject = { key: string; size: number; lastModified?: string };
export type AdminCloudRestoreStatus = {
  phase: "idle" | "listing" | "waiting_backup" | "downloading" | "validating" | "ready" | "applying" | "completed" | "failed";
  progress?: number;
  sourceKey?: string;
  message: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
};

export type AdminPortableBackupPreview = {
  ticket: string;
  summary: { files: number; clients: number; routes: number; validatedRoutes: number };
  message: string;
};

export async function exportAdminPortableBackup(passphrase: string) {
  const token = getPanelToken();
  const headers = new Headers({ "x-backup-passphrase": passphrase });
  if (token) headers.set("x-panel-token", token);
  const response = await fetch("/api/admin/portable-backup/export", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5 * 60_000)
  });
  if (getPanelToken() !== token) throw new Error("A sessão mudou durante a solicitação.");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Não foi possível criar o arquivo portátil.");
  }
  return { blob: await response.blob(), filename: response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "bot-rotas-backup.botbackup" };
}

export async function previewAdminPortableBackup(file: File, passphrase: string) {
  const token = getPanelToken();
  const headers = new Headers({ "Content-Type": "application/octet-stream", "x-backup-passphrase": passphrase });
  if (token) headers.set("x-panel-token", token);
  const response = await fetch("/api/admin/portable-backup/preview", {
    method: "POST",
    headers,
    body: file,
    signal: AbortSignal.timeout(10 * 60_000)
  });
  const data = await response.json().catch(() => ({}));
  if (getPanelToken() !== token) throw new Error("A sessão mudou durante a solicitação.");
  if (!response.ok) throw new Error(data.error || "Não foi possível validar o arquivo.");
  return data as AdminPortableBackupPreview;
}

export function applyAdminPortableBackup(ticket: string) {
  return fetchJson<{ accepted: boolean; message: string }>("/api/admin/portable-backup/apply", {
    method: "POST",
    body: JSON.stringify({ ticket, confirmation: "IMPORTAR DADOS" })
  });
}

export function getAdminCloudBackupStatus() {
  return fetchJson<AdminCloudBackupStatus>("/api/admin/cloud-backup");
}

export function triggerAdminCloudBackup() {
  return fetchJson<{ accepted: boolean; status: AdminCloudBackupStatus }>("/api/admin/cloud-backup", { method: "POST" });
}

export function getAdminCloudBackupObjects() {
  return fetchJson<{ objects: AdminCloudBackupObject[] }>("/api/admin/cloud-backup/objects");
}

export function getAdminCloudRestoreStatus() {
  return fetchJson<AdminCloudRestoreStatus>("/api/admin/cloud-backup/restore-status");
}

export function restoreAdminCloudBackup(sourceKey: string) {
  return fetchJson<{ accepted: boolean; message: string; sourceKey: string }>("/api/admin/cloud-backup/restore", {
    method: "POST",
    body: JSON.stringify({ confirmation: "RESTAURAR DADOS", sourceKey })
  });
}

export function decideImageUsage(id: string, payload: { decision: "pending" | "billable" | "excluded"; amountCents?: number; note?: string }) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/image-usage/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function saveImagePricing(clientEmail: string, amountCents: number) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/image-pricing/${encodeURIComponent(clientEmail)}`, {
    method: "PATCH",
    body: JSON.stringify({ amountCents })
  });
}

export function saveImageMonthlyTotal(clientEmail: string, amountCents: number, month?: string) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/image-total/${encodeURIComponent(clientEmail)}`, {
    method: "PATCH",
    body: JSON.stringify({ amountCents, month })
  });
}

export function saveRouteBillingMode(clientEmail: string, enabled: boolean) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/route-billing/${encodeURIComponent(clientEmail)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export function saveClientFinance(clientEmail: string, payload: { routePriceCents?: number; dueDay?: number; prepaidRoutesRemaining?: number; paymentEveryRoutes?: number }) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/client-finance/${encodeURIComponent(clientEmail)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function registerClientPayment(clientEmail: string) {
  return fetchJson<AdminImageUsageSnapshot>(`/api/admin/client-payment/${encodeURIComponent(clientEmail)}`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function subscribeAdminMonitor(callback: (snapshot: AdminMonitorSnapshot) => void, onError?: (error?: unknown) => void) {
  const token = getPanelToken();
  if (!token) return () => undefined;
  return subscribeSnapshots({
    load: (signal) => fetchJson<AdminMonitorSnapshot>("/api/admin/monitor", { signal }),
    listen: createSnapshotListener<AdminMonitorSnapshot>(`/api/admin/events?token=${encodeURIComponent(token)}`),
    receive: (snapshot) => { if (getPanelToken() === token) callback(snapshot); },
    onError,
    intervalMs: 15000
  });
}

export function validateAdminRoute(routeId: string) {
  return fetchJson<AdminRoutesSnapshot>(`/api/admin/routes/${encodeURIComponent(routeId)}/validate`, {
    method: "PATCH",
    body: JSON.stringify({})
  });
}

export function rejectAdminRoute(routeId: string, reason?: string) {
  return fetchJson<AdminRoutesSnapshot>(`/api/admin/routes/${encodeURIComponent(routeId)}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ reason })
  });
}

export function bulkDecideAdminRoutes(payload: { routeIds: string[]; decision: "validate" | "reject"; reason?: string }) {
  return fetchJson<AdminRoutesSnapshot & { changed: number }>("/api/admin/routes/bulk", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getAdminUsers() {
  return fetchJson<AdminUsersSnapshot>("/api/admin/users");
}

export function getAdminUserDetail(email: string) {
  return fetchJson<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(email)}`);
}

export function saveAdminUser(payload: {
  originalEmail?: string;
  email: string;
  password?: string;
  role: PanelUserRole;
  blocked: boolean;
  color: string;
  dispatchPriorityLevel: number;
  dispatchBeatsEmail?: string;
  dispatchAdvantageMs?: number;
  dispatchMatchups?: import("../../shared/types").DispatchMatchupRule[];
}) {
  const isEdit = Boolean(payload.originalEmail);
  return fetchJson<AdminUsersSnapshot>(
    isEdit ? `/api/admin/users/${encodeURIComponent(payload.originalEmail || "")}` : "/api/admin/users",
    {
      method: isEdit ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    }
  );
}

export function runAdminUserBotAction(email: string, actionName: string, payload: Record<string, unknown> = {}) {
  return fetchJson<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(email)}/action/${encodeURIComponent(actionName)}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function saveAdminLeader(payload: LeaderContact) {
  return fetchJson<{ leaders: LeaderContact[] }>("/api/admin/leaders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function removeAdminLeader(phone: string) {
  return fetchJson<{ leaders: LeaderContact[] }>(`/api/admin/leaders/${encodeURIComponent(phone)}`, {
    method: "DELETE"
  });
}

export function sendSupportMessage(payload: { email: string; message: string }) {
  return fetchJson<{ ok: boolean }>("/api/support/messages", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getAdminSupportMessages() {
  return fetchJson<AdminSupportMessagesSnapshot>("/api/admin/support/messages");
}

export function markSupportMessageRead(id: string) {
  return fetchJson<AdminSupportMessagesSnapshot>(`/api/admin/support/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({})
  });
}

export function clearAdminMaintenance(payload: { target: "logs" | "routes" | "support" | "all"; clientEmail?: string }) {
  return fetchJson<AdminMonitorSnapshot>("/api/admin/maintenance/clear", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function uploadRomaneio(file: File) {
  if (window.botApi?.uploadRomaneio) return window.botApi.uploadRomaneio(file.name, await file.arrayBuffer());
  const formData = new FormData();
  formData.set("file", file);
  return fetchForm<RomaneioSnapshot>("/api/romaneio/upload", formData);
}

export function clearRomaneio() {
  if (window.botApi?.clearRomaneio) return window.botApi.clearRomaneio();
  return fetchJson<RomaneioSnapshot>("/api/romaneio/clear", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getRomaneio() {
  if (window.botApi?.getRomaneio) return window.botApi.getRomaneio();
  return fetchJson<RomaneioSnapshot>("/api/romaneio/routes");
}

export function saveRomaneioSettings(settings: RomaneioSettings) {
  if (window.botApi?.saveRomaneioSettings) return window.botApi.saveRomaneioSettings(settings);
  return fetchJson<RomaneioSettings>("/api/romaneio/settings", {
    method: "POST",
    body: JSON.stringify(settings)
  });
}

export function locateRomaneio() {
  if (window.botApi?.locateRomaneio) return window.botApi.locateRomaneio();
  return fetchJson<RomaneioLocateResult>("/api/romaneio/locate", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function confirmRomaneio(candidateId: string) {
  if (window.botApi?.confirmRomaneio) return window.botApi.confirmRomaneio(candidateId);
  return fetchJson<RomaneioSnapshot>("/api/romaneio/confirm", {
    method: "POST",
    body: JSON.stringify({ candidateId })
  });
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  const token = getPanelToken();
  if (token) headers.set("x-panel-token", token);

  const response = await fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (getPanelToken() !== token) throw new Error("A sess\u00e3o mudou durante a solicita\u00e7\u00e3o.");
  if (!response.ok) {
    throw new ApiError(data.error || "Falha ao conversar com o servidor.", response.status);
  }

  return data as T;
}

async function fetchForm<T>(url: string, body: FormData): Promise<T> {
  const headers = new Headers();
  const token = getPanelToken();
  if (token) headers.set("x-panel-token", token);

  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(60_000),
    body
  });

  const data = await response.json().catch(() => ({}));
  if (getPanelToken() !== token) throw new Error("A sess\u00e3o mudou durante a solicita\u00e7\u00e3o.");
  if (!response.ok) {
    throw new ApiError(data.error || "Falha ao enviar arquivo.", response.status);
  }

  return data as T;
}

function action<TPayload = unknown>(name: string, payload?: TPayload) {
  return fetchJson<BotSnapshot>(`/api/action/${name}`, {
    method: "POST",
    body: JSON.stringify(payload || {})
  }).then(parseClientSnapshot);
}

function createSnapshotListener<T>(url: string, parse?: (value: unknown) => T) {
  if (!("EventSource" in window)) return undefined;
  return (receive: (snapshot: T) => void, fail: () => void) => {
    const source = new EventSource(url);
    source.onmessage = (event) => {
      let snapshot: T;
      try {
        const data = JSON.parse(event.data);
        snapshot = parse ? parse(data) : data as T;
      } catch {
        fail();
        return;
      }
      receive(snapshot);
    };
    source.onerror = fail;
    return () => source.close();
  };
}

function createWebApi(): DesktopApi {
  return {
    reportRendererHeartbeat: () => undefined,
    getSnapshot: () => fetchJson<BotSnapshot>("/api/snapshot").then(parseClientSnapshot),
    startBot: () => action("start"),
    stopBot: () => action("stop"),
    restartBot: () => action("restart"),
    clearSession: () => action("clear-session"),
    refreshQrCode: () => action("refresh-qr"),
    factoryReset: () => action("factory-reset"),
    clearLogs: () => action("clear-logs"),
    refreshGroups: () => action("refresh-groups"),
    startMonitoring: () => action("start-monitoring"),
    startImageMonitoring: () => action("start-image-monitoring"),
    startNuclearMonitoring: () => action("start-nuclear-monitoring"),
    startTestMonitoring: () => action("start-test-monitoring"),
    stopMonitoring: () => action("stop-monitoring"),
    simulateOpening: () => action("simulate-opening"),
    manualDispatch: () => action("manual-dispatch"),
    simulateTargetDispatch: () => action("simulate-target-dispatch"),
    latencyProbe: () => action("latency-probe"),
    saveGroup: (payload: SaveGroupPayload) => action("save-group", payload),
    saveTestGroup: (payload: SaveGroupPayload) => action("save-test-group", payload),
    warmupGroups: () => action("warmup"),
    saveCodes: (payload: SaveCodesPayload) => action("save-codes", payload),
    saveMessageSettings: (payload: SaveMessageSettingsPayload) => action("save-message-settings", payload),
    saveWarmupMessageSettings: (payload: SaveWarmupMessageSettingsPayload) =>
      action("save-warmup-message-settings", payload),
    saveTargetMessageSettings: (payload: SaveTargetMessageSettingsPayload) =>
      action("save-target-message-settings", payload),
    saveRoutePreset: (payload) => action("save-route-preset", payload),
    deleteRoutePreset: (payload) => action("delete-route-preset", payload),
    saveGeneralSettings: (payload: GeneralSettingsPayload) => action("save-general-settings", payload),
    confirmOcrRoutes: (payload: { optionIds: string[] }) => action("confirm-ocr-routes", payload),
    submitRouteIncident: (payload: { routeId: string; valid: boolean; reason: string }) =>
      action("submit-route-incident", payload),
    snoozeRouteIncident: (payload: { routeId: string }) => action("snooze-route-incident", payload),
    onSnapshot: (callback: (snapshot: BotSnapshot) => void, onError?: (error: unknown) => void) => {
      const token = getPanelToken();
      return subscribeSnapshots({
        load: (signal) => fetchJson<BotSnapshot>("/api/snapshot", { signal }).then(parseClientSnapshot),
        listen: token ? createSnapshotListener<BotSnapshot>(`/events?token=${encodeURIComponent(token)}`, parseClientSnapshot) : undefined,
        receive: (snapshot) => { if (getPanelToken() === token) callback(snapshot); },
        onError,
        intervalMs: 1000,
        maxSilenceMs: 5000
      });
    }
  };
}

export const botApi: DesktopApi = window.botApi || createWebApi();
