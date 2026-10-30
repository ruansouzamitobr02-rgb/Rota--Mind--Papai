import { mergeUsageAmounts, parseMoneyInput } from "./usageDrafts";
import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  Bell,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  Download,
  FileJson,
  Gauge,
  History,
  Inbox,
  LogIn,
  LogOut,
  MessageSquareText,
  RefreshCw,
  Route,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wifi,
  X,
  Zap
} from "lucide-react";
import { uiText } from "../uiText";
import { AnalysisImage } from "../components/AnalysisImage";
import {
  AdminLogEntry,
  AdminImageUsageSnapshot,
  AdminMonitorSnapshot,
  AdminRoutesSnapshot,
  AdminSupportMessagesSnapshot,
  AdminUserDetail,
  AdminUserSummary,
  AdminUsersSnapshot,
  DispatchMatchupRule,
  LeaderContact,
  PanelUserRole,
  RouteDispatch,
  SupportMessage
} from "../../../shared/types";
import {
  bulkDecideAdminRoutes,
  clearAdminMaintenance,
  decideImageUsage,
  AdminCloudBackupStatus,
  AdminCloudBackupObject,
  AdminCloudRestoreStatus,
  AdminPortableBackupPreview,
  applyAdminPortableBackup,
  exportAdminPortableBackup,
  getAdminCloudBackupStatus,
  getAdminCloudBackupObjects,
  getAdminCloudRestoreStatus,
  previewAdminPortableBackup,
  restoreAdminCloudBackup,
  getAdminMonitor,
  getAdminUserDetail,
  isAuthError,
  markSupportMessageRead,
  rejectAdminRoute,
  removeAdminLeader,
  runAdminUserBotAction,
  saveAdminLeader,
  saveAdminUser,
  saveImagePricing,
  saveImageMonthlyTotal,
  saveClientFinance,
  registerClientPayment,
  saveRouteBillingMode,
  subscribeAdminMonitor,
  triggerAdminCloudBackup,
  validateAdminRoute
} from "../api";
import { enableWebPushNotifications } from "../pushNotifications";
import { AdminDatePreset, getAdminDatePreset, isDateInsideAdminRange } from "../adminDateFilter";

type AdminCommandCenterProps = {
  userEmail: string;
  onLogout: () => void;
  onEnterClientMode: (email: string) => void | Promise<void>;
};

type AdminPage = "today" | "operations" | "dashboard" | "clients" | "validations" | "reactions" | "validated_ai" | "validated_routes" | "costs" | "usage" | "history" | "logs" | "support" | "reports" | "maintenance" | "settings";
type DatePreset = "today" | "7d" | "30d" | "all";
type ReportDatePreset = AdminDatePreset | "custom";
type DecisionFilter = "all" | "pending" | "validated" | "rejected" | "leader" | "removed";
type ModeFilter = "all" | "target" | "test" | "manual" | "automatic" | "ocr" | "warmup" | "simulation";
type LogLevelFilter = "all" | "info" | "success" | "warning" | "error";
type CleanupTarget = "logs" | "routes" | "support" | "all";

type UserEditorState = {
  originalEmail?: string;
  email: string;
  password: string;
  role: PanelUserRole;
  blocked: boolean;
  color: string;
  dispatchPriorityLevel: number;
  dispatchBeatsEmail?: string;
  dispatchAdvantageMs: number;
  dispatchMatchups: DispatchMatchupRule[];
};

type RejectRequest = {
  routeIds: string[];
  title: string;
};

const emptyRoutes: AdminRoutesSnapshot = {
  routes: [],
  pendingReactionRoutes: [],
  totals: { routes: 0, validated: 0, rejected: 0, pending: 0, reactions: 0, removedReactions: 0, clients: 0 }
};

const emptyUsers: AdminUsersSnapshot = { users: [] };
const emptySupport: AdminSupportMessagesSnapshot = { messages: [], unread: 0 };
const emptyImageUsage: AdminImageUsageSnapshot = {
  month: new Date().toISOString().slice(0, 7),
  entries: [],
  clients: [],
  totals: { total: 0, pending: 0, billable: 0, excluded: 0, detected: 0, amountCents: 0, unpaidRoutes: 0 }
};

const emptyEditor: UserEditorState = {
  email: "",
  password: "",
  role: "client",
  blocked: false,
  color: "#38bdf8",
  dispatchPriorityLevel: 0,
  dispatchBeatsEmail: "",
  dispatchAdvantageMs: 400,
  dispatchMatchups: []
};

const REAL_VALIDATION_GROUP = "MOTORISTAS - CAMPOS DOS GOYTACAZES";

function normalizeAdminText(value?: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("pt-BR") : "Sem registro";
}

function formatBackupSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatShort(value?: string) {
  return value
    ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "--";
}

function formatDuration(ms = 0) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h ${rest}m`;
  if (hours) return `${hours}h`;
  return `${rest}m`;
}

function formatMs(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "sem dado";
  if (value >= 60_000) return `${(value / 60_000).toFixed(1).replace(".0", "")}min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(".0", "")}s`;
  return `${Math.round(value)}ms`;
}

function formatMoney(cents = 0) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function routeDecision(route: RouteDispatch) {
  return route.decisionStatus || (route.validated ? "validated" : "pending");
}

function routeDecisionLabel(route: RouteDispatch) {
  if (routeDecision(route) === "pending") return "Pendente";
  if (routeDecision(route) === "rejected") return "Excluída pelo admin";
  return route.decisionSource === "leader_reaction_1h" ? "Validação automática antiga" : "Validada pelo admin";
}

function triggerLabel(route: RouteDispatch) {
  if (route.ocr) return "Imagem IA";
  if (route.trigger === "target-simulation") return "Simulação alvo";
  if (route.trigger === "simulation") return "Simulação abertura";
  if (route.trigger === "warmup") return "Aquecimento";
  if (route.trigger === "manual") return "Envio manual pelo painel";
  if (route.mode === "test") return "Teste";
  return "Rota configurada automática";
}

function openingSignalLabel(signal?: NonNullable<RouteDispatch["dispatchTimeline"]>["openingSignal"]) {
  if (signal === "group_update") return "Evento oficial do grupo";
  if (signal === "opening_message") return "Mensagem de abertura";
  if (signal === "already_open") return "Grupo já estava aberto";
  if (signal === "image_ready") return "Imagem pronta com grupo aberto";
  if (signal === "manual") return "Comando manual do painel";
  if (signal === "simulation") return "Simulação";
  return "Não registrado";
}

function routeAgeState(route: RouteDispatch) {
  const ageMs = Date.now() - new Date(route.createdAt).getTime();
  return ageMs <= 10 * 60 * 1000 ? "recent" : "past";
}

function reactionFinalLabel(route: RouteDispatch) {
  if (route.lastReactionState?.status === "removed") return "Reagiu e removeu";
  if (route.lastReactionState?.status === "active") return "Reagiu e manteve";
  if (route.reactions.length) return "Reagiu e manteve";
  return "Sem reação";
}

function incidentLabel(route: RouteDispatch) {
  if (!route.clientIncident) return "Sem incidente";
  if (route.clientIncident.answeredAt) {
    return `${route.clientIncident.valid ? "Cliente marcou válida" : "Cliente marcou não válida"} - ${route.clientIncident.reason || "sem motivo"}`;
  }
  return "Aguardando explicação do cliente";
}

function clientIncidentSummary(route: RouteDispatch) {
  if (!route.clientIncident) return "";
  if (!route.clientIncident.answeredAt) return "Cliente ainda não explicou";
  return `${route.clientIncident.valid ? "Cliente disse válida" : "Cliente disse não válida"}: ${route.clientIncident.reason || "sem motivo"}`;
}

function hasLeaderReaction(route: RouteDispatch) {
  return route.reactions.some((reaction) => reaction.isAdmin) || route.reactionsHistory?.some((event) => event.isAdmin);
}

function hasAnyReaction(route: RouteDispatch) {
  return Boolean(
    route.reactions.length ||
    route.reactionsHistory?.length ||
    route.lastReactionState?.status === "active" ||
    route.lastReactionState?.status === "removed"
  );
}

function routeBusinessLabel(route: RouteDispatch) {
  return route.ocr?.bairro || route.ocr?.route || route.ocr?.code || route.messages[0] || route.groupName || "Rota sem nome";
}

function uniqueDays(routes: RouteDispatch[]) {
  return new Set(routes.map((route) => new Date(route.createdAt).toISOString().slice(0, 10))).size;
}

function averageNumber(values: number[]) {
  if (!values.length) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function routeP95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0);
}

function topLabels(routes: RouteDispatch[], limit = 3) {
  const counts = new Map<string, number>();
  routes.forEach((route) => {
    const label = routeBusinessLabel(route);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function isRealValidationRoute(route: RouteDispatch) {
  const targetGroup = normalizeAdminText(REAL_VALIDATION_GROUP);
  const groupName = normalizeAdminText(route.groupName);
  const groupJid = normalizeAdminText(route.groupJid);
  const sentInRealGroup = groupName === targetGroup || groupName.includes(targetGroup) || groupJid.includes(targetGroup);
  return sentInRealGroup && route.mode === "target" && !["warmup", "simulation", "target-simulation"].includes(route.trigger);
}

function needsRealReview(route: RouteDispatch) {
  return isRealValidationRoute(route) && routeDecision(route) === "pending";
}

function colorStyle(color?: string) {
  return { "--client-color": color || "#38bdf8" } as CSSProperties;
}

function dateRangeMs(preset: DatePreset) {
  const now = Date.now();
  if (preset === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { start: start.getTime(), end: now };
  }
  if (preset === "7d") return { start: now - 7 * 86400000, end: now };
  if (preset === "30d") return { start: now - 30 * 86400000, end: now };
  return { start: 0, end: Number.MAX_SAFE_INTEGER };
}

function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Array<Record<string, unknown>>) {
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((key) => escape(row[key])).join(","))].join("\n");
}

function MetricCard({
  title,
  value,
  detail,
  tone,
  Icon
}: {
  title: string;
  value: string | number;
  detail: string;
  tone: "blue" | "green" | "yellow" | "red";
  Icon: typeof Activity;
}) {
  return (
    <article className={`adminx-metric adminx-${tone}`}>
      <span><Icon size={20} /></span>
      <div>
        <small>{title}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </article>
  );
}

function StatusPill({ tone, children }: { tone: "blue" | "green" | "yellow" | "red" | "muted"; children: ReactNode }) {
  return <span className={`adminx-pill adminx-pill-${tone}`}>{children}</span>;
}

function UserEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSave,
  competitors
}: {
  value: UserEditorState;
  busy: boolean;
  onChange: (value: UserEditorState) => void;
  onCancel: () => void;
  onSave: () => void;
  competitors: AdminUserSummary[];
}) {
  return (
    <form className="adminx-editor" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <input type="email" placeholder="Email" value={value.email} onChange={(event) => onChange({ ...value, email: event.target.value })} />
      <input type="password" placeholder={value.originalEmail ? "Nova senha opcional" : "Senha"} value={value.password} onChange={(event) => onChange({ ...value, password: event.target.value })} />
      <select value={value.role} onChange={(event) => onChange({ ...value, role: event.target.value === "admin" ? "admin" : "client" })}>
        <option value="client">Cliente</option>
        <option value="admin">Admin</option>
      </select>
      <label className="adminx-check">
        <input type="checkbox" checked={value.blocked} onChange={(event) => onChange({ ...value, blocked: event.target.checked })} />
        Bloqueado
      </label>
      <div className="adminx-field adminx-matchups">
        <span>Confrontos de prioridade</span>
        {value.dispatchMatchups.map((rule, index) => (
          <div className="adminx-matchup-row" key={`${rule.opponentEmail}-${index}`}>
            <select value={rule.outcome} onChange={(event) => onChange({ ...value, dispatchMatchups: value.dispatchMatchups.map((item, itemIndex) => itemIndex === index ? { ...item, outcome: event.target.value === "loses" ? "loses" : "wins" } : item) })}>
              <option value="wins">Ganha de</option>
              <option value="loses">Perde para</option>
            </select>
            <select value={rule.opponentEmail} onChange={(event) => onChange({ ...value, dispatchMatchups: value.dispatchMatchups.map((item, itemIndex) => itemIndex === index ? { ...item, opponentEmail: event.target.value } : item) })}>
              {competitors.filter((user) => user.role === "client" && user.email !== (value.originalEmail || value.email)).map((user) => <option key={user.email} value={user.email}>{user.email}</option>)}
            </select>
            <input aria-label="Diferença em milissegundos" min={400} max={10000} step={50} type="number" value={rule.delayMs} onChange={(event) => onChange({ ...value, dispatchMatchups: value.dispatchMatchups.map((item, itemIndex) => itemIndex === index ? { ...item, delayMs: Math.max(400, Number(event.target.value) || 400) } : item) })} />
            <span>ms</span>
            <button className="icon-button danger" title="Remover confronto" type="button" onClick={() => onChange({ ...value, dispatchMatchups: value.dispatchMatchups.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={16} /></button>
          </div>
        ))}
        <button className="button" type="button" onClick={() => {
          const ownEmail = value.originalEmail || value.email;
          const used = new Set(value.dispatchMatchups.map((rule) => rule.opponentEmail));
          const opponent = competitors.find((user) => user.role === "client" && user.email !== ownEmail && !used.has(user.email));
          if (opponent) onChange({ ...value, dispatchMatchups: [...value.dispatchMatchups, { opponentEmail: opponent.email, outcome: "wins", delayMs: 400 }] });
        }}>Adicionar confronto</button>
        {!value.dispatchMatchups.length ? <small>Sem confrontos: este cliente não ganha nem perde prioridade para ninguém.</small> : null}
      </div>
      <input type="color" value={value.color} onChange={(event) => onChange({ ...value, color: event.target.value })} />
      <button className="button" type="button" onClick={onCancel}>Cancelar</button>
      <button className="button primary" disabled={busy || !value.email.trim() || (!value.originalEmail && !value.password.trim())} type="submit">
        Salvar
      </button>
    </form>
  );
}

function RouteSidePanel({
  route,
  onClose,
  onValidate,
  onReject
}: {
  route: RouteDispatch;
  onClose: () => void;
  onValidate: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <aside className="adminx-sidepanel" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>{route.clientEmail}</p>
            <h2>{route.groupName || route.groupJid || "Grupo sem nome"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Fechar"><X size={20} /></button>
        </header>
        <section className="adminx-detail-grid">
          <MetricCard Icon={Zap} tone="blue" title="Origem" value={triggerLabel(route)} detail={route.mode} />
          <MetricCard Icon={MessageSquareText} tone={route.lastReactionState?.status === "removed" ? "yellow" : route.reactions.length ? "green" : "blue"} title="Reação final" value={reactionFinalLabel(route)} detail={formatShort(route.lastReactionState?.updatedAt)} />
          <MetricCard Icon={SendIcon} tone={route.status === "sent" ? "green" : route.status === "failed" ? "red" : "yellow"} title="Envio" value={`${route.confirmedCount}/${route.totalCount}`} detail={route.status} />
          <MetricCard Icon={ShieldCheck} tone={routeDecision(route) === "validated" ? "green" : routeDecision(route) === "rejected" ? "red" : "yellow"} title="Decisão" value={routeDecision(route)} detail={route.validatedBy || route.rejectedBy || "pendente"} />
        </section>
        <section className="adminx-detail-section">
          <h3>Dados do envio</h3>
          <dl className="adminx-kv">
            <dt>Cliente</dt><dd>{route.clientEmail || "Não identificado"}</dd>
            <dt>Grupo</dt><dd>{route.groupName || route.groupJid || "Não identificado"}</dd>
            <dt>Modo</dt><dd>{route.mode}</dd>
            <dt>Trigger</dt><dd>{triggerLabel(route)}</dd>
            <dt>Sinal que iniciou</dt><dd>{openingSignalLabel(route.dispatchTimeline?.openingSignal)}</dd>
            <dt>Mensagem enviada em</dt><dd>{formatDate(route.createdAt)}</dd>
            <dt>Recência</dt><dd>{routeAgeState(route) === "recent" ? "Recente (menos de 10 minutos)" : "Passada (mais de 10 minutos)"}</dd>
            <dt>Atualizada</dt><dd>{formatDate(route.updatedAt)}</dd>
            <dt>Motivo do admin</dt><dd>{route.decisionReason || "Sem motivo registrado"}</dd>
            <dt>Tipo da validação</dt><dd>{route.decisionSource === "leader_reaction_1h" ? "Registro legado da automação desativada" : routeDecision(route) === "pending" ? "Aguardando decisão manual" : "Decisão manual do admin"}</dd>
            {route.validationLeaderName ? <><dt>Líder responsável</dt><dd>{route.validationLeaderName}</dd></> : null}
            {route.validationReactionAt ? <><dt>Reação iniciada</dt><dd>{formatDate(route.validationReactionAt)}</dd></> : null}
          </dl>
        </section>
        {route.dispatchTimeline ? (
          <section className="adminx-detail-section">
            <h3>Diagnóstico do disparo</h3>
            <div className="adminx-timeline-metrics">
              <span><b>{formatMs(route.dispatchTimeline.detectionDelayMs)}</b><small>detecção</small></span>
              <span><b>{formatMs(route.dispatchTimeline.firstRelayCallMs)}</b><small>1o relay</small></span>
              <span><b>{formatMs(route.dispatchTimeline.firstAckMs)}</b><small>1o ACK</small></span>
              <span><b>{formatMs(route.dispatchTimeline.totalDurationMs)}</b><small>total</small></span>
            </div>
            <dl className="adminx-kv">
              <dt>Modo corrida</dt><dd>{route.dispatchTimeline.mode === "race" ? "ativo" : "normal"}</dd>
              <dt>Gatilho mais rápido</dt><dd>{openingSignalLabel(route.dispatchTimeline.openingSignal)}</dd>
              <dt>Armazenamento da sessão</dt><dd>{route.dispatchTimeline.authBackend === "sqlite" ? "SQLite transacional" : "Arquivos legados"}</dd>
              <dt>Preparação interna</dt><dd>{route.dispatchTimeline.internalWarmState === "ready" ? "Aquecida" : route.dispatchTimeline.internalWarmState || "Não registrada"}</dd>
              <dt>Dispositivos aquecidos</dt><dd>{route.dispatchTimeline.warmedDeviceCount ?? "Não registrado"}</dd>
              <dt>RTT do socket</dt><dd>{formatMs(route.dispatchTimeline.socketRttMs)}</dd>
              <dt>Leitura de chaves</dt><dd>{formatMs(route.dispatchTimeline.signalKeyReadMs)} ({route.dispatchTimeline.signalKeyReadOps || 0} operação(ões))</dd>
              <dt>Gravação de chaves</dt><dd>{formatMs(route.dispatchTimeline.signalKeyWriteMs)} ({route.dispatchTimeline.signalKeyWriteOps || 0} operação(ões))</dd>
              <dt>Segunda mensagem</dt><dd>{route.dispatchTimeline.secondLaneMode === "speculative" ? "Faixa rápida adaptativa" : "Protegida pelo ACK"}</dd>
              <dt>Timeout usado</dt><dd>{route.dispatchTimeline.timeoutUsed ? "sim" : "não"}</dd>
              <dt>Retry usado</dt><dd>{route.dispatchTimeline.retryUsed ? "sim" : "não"}</dd>
              <dt>Not acceptable</dt><dd>{route.dispatchTimeline.notAcceptableCount}</dd>
            </dl>
            <div className="adminx-dispatch-timeline">
              {route.dispatchTimeline.events.map((event) => (
                <span className={`adminx-timeline-${event.level || "info"}`} key={event.id}>
                  <b>+{event.offsetMs}ms</b>
                  <strong>{event.label}</strong>
                  {event.detail ? <small>{event.detail}</small> : null}
                </span>
              ))}
            </div>
          </section>
        ) : null}
        <section className="adminx-detail-section">
          <h3>Mensagens enviadas</h3>
          <div className="adminx-chip-stack">
            {route.messages.map((message, index) => <span key={`${route.id}-msg-${index}`}>{uiText(message)}</span>)}
          </div>
        </section>
        {route.ocr ? (
          <section className="adminx-detail-section adminx-analysis-replay">
            <div className="adminx-replay-heading"><div><p className="panel-label">Replay do cliente</p><h3>Análise inteligente da imagem</h3></div><span className={`status-pill ${route.status === "sent" ? "tone-green" : "tone-yellow"}`}>{route.status === "sent" ? "Enviada" : route.status}</span></div>
            {route.ocr.imagePreviewUrl ? <AnalysisImage className="adminx-ocr-preview" src={route.ocr.imagePreviewUrl} alt="Prévia da imagem processada" /> : null}
            {route.ocr.analysisMessage ? <p className="adminx-replay-message">{route.ocr.analysisMessage}</p> : null}
            {route.ocr.analysisOptions?.length ? <div className="adminx-replay-routes">{route.ocr.analysisOptions.map((option) => <article key={option.id}><strong>{option.gaiola}</strong><span>{option.bairro}</span><small>{option.paradas ? `${option.paradas} paradas` : "Paradas não identificadas"}</small><small>{option.pacotes ? `${option.pacotes} pacotes` : "Pacotes não identificados"}</small></article>)}</div> : null}
            {route.ocr.analysisTiming ? <div className="adminx-replay-timing"><span><small>Baixar</small><b>{formatMs(route.ocr.analysisTiming.downloadMs)}</b></span><span><small>Analisar</small><b>{formatMs(route.ocr.analysisTiming.ocrMs)}</b></span><span><small>Comparar</small><b>{formatMs(route.ocr.analysisTiming.comparisonMs)}</b></span><span><small>Total IA</small><b>{formatMs(route.ocr.analysisTiming.totalMs)}</b></span></div> : null}
            <dl className="adminx-kv">
              <dt>Rota</dt><dd>{route.ocr.route || route.ocr.bairro || "Não registrada"}</dd>
              <dt>Código</dt><dd>{route.ocr.code || "Não registrado"}</dd>
              <dt>Paradas</dt><dd>{route.ocr.paradas || route.ocr.analysisOptions?.[0]?.paradas || "Não identificadas"}</dd>
              <dt>Pacotes</dt><dd>{route.ocr.pacotes || route.ocr.analysisOptions?.[0]?.pacotes || "Não identificados"}</dd>
              <dt>Motor</dt><dd>Análise visual local</dd>
              <dt>Confiança</dt><dd>{route.ocr.confidence ? `${route.ocr.confidence}%` : "Sem média"}</dd>
              <dt>Linha</dt><dd>{route.ocr.line || "Sem linha"}</dd>
              <dt>Análise concluída</dt><dd>{formatDate(route.ocr.processedAt)}</dd>
              <dt>Até iniciar o envio</dt><dd>{formatMs(Math.max(0, new Date(route.createdAt).getTime() - new Date(route.ocr.processedAt).getTime()))}</dd>
              <dt>Duração do envio</dt><dd>{formatMs(route.dispatchTimeline?.totalDurationMs)}</dd>
            </dl>
            {route.ocr.preparedMessages?.length ? <><h4>Mensagens preparadas</h4><div className="adminx-chip-stack">{route.ocr.preparedMessages.map((message, index) => <span key={`${route.id}-ocr-message-${index}`}>{message}</span>)}</div></> : null}
            {route.ocr.text ? <pre className="adminx-ocr-text">{route.ocr.text}</pre> : null}
          </section>
        ) : null}
        {route.clientIncident ? (
          <section className="adminx-detail-section">
            <h3>Explicação obrigatória do cliente</h3>
            <dl className="adminx-kv">
              <dt>Status</dt><dd>{route.clientIncident.answeredAt ? "Respondido" : "Aguardando cliente"}</dd>
              <dt>Tipo</dt><dd>{route.clientIncident.kind === "message_deleted" ? "Mensagem apagada" : "Reação removida pelo líder"}</dd>
              <dt>Rota válida?</dt><dd>{route.clientIncident.valid === undefined ? "Sem resposta" : route.clientIncident.valid ? "Sim" : "Não"}</dd>
              <dt>Motivo</dt><dd>{route.clientIncident.reason || "Sem motivo informado"}</dd>
              <dt>Criado</dt><dd>{formatDate(route.clientIncident.createdAt)}</dd>
              <dt>Respondido</dt><dd>{formatDate(route.clientIncident.answeredAt)}</dd>
            </dl>
          </section>
        ) : null}
        <section className="adminx-detail-section">
          <h3>Reações</h3>
          {route.reactions.length ? route.reactions.map((reaction) => (
            <div className="adminx-reaction-row" key={reaction.id}>
              <b>{reaction.emoji || "?"}</b>
              <span>{reaction.isAdmin ? `Líder ${reaction.leaderName || ""}` : "Comum"}</span>
              <small>{reaction.senderPhone || reaction.senderJid}</small>
            </div>
          )) : <p className="adminx-empty-text">Nenhuma reação ativa registrada.</p>}
          {route.reactionsHistory?.length ? (
            <div className="adminx-history-events">
              {route.reactionsHistory.map((event) => (
                <span key={event.id}>
                  {event.action === "remove" ? "Removeu" : "Reagiu"} {event.emoji || ""} - {formatDate(event.timestamp)}
                </span>
              ))}
            </div>
          ) : null}
        </section>
        <footer>
          <button className="button primary" type="button" onClick={() => onValidate(route.id)}>Validar</button>
          <button className="button danger" type="button" onClick={() => onReject(route.id)}>Rejeitar</button>
        </footer>
      </aside>
    </div>
  );
}

const SendIcon = Zap;

function ClientSidePanel({
  detail,
  busy,
  onClose,
  onAction
}: {
  detail: AdminUserDetail;
  busy: boolean;
  onClose: () => void;
  onAction: (email: string, action: string) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <aside className="adminx-sidepanel wide" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>{detail.role === "admin" ? "Administrador" : "Cliente"}</p>
            <h2>{detail.email}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Fechar"><X size={20} /></button>
        </header>
        <section className="adminx-detail-grid">
          <MetricCard Icon={Activity} tone={detail.panelOnline ? "green" : "blue"} title="Painel" value={detail.presenceStatus} detail={formatShort(detail.lastSeenAt)} />
          <MetricCard Icon={Bot} tone={detail.monitoringEnabled ? "green" : "yellow"} title="Bot" value={detail.botStatus} detail={detail.monitoringMode || "parado"} />
          <MetricCard Icon={Clock3} tone="blue" title="Uso" value={formatDuration(detail.totalUsageMs)} detail={`${detail.loginCount} login(s)`} />
          <MetricCard Icon={History} tone="green" title="Rotas" value={detail.routes.length} detail="histórico salvo" />
        </section>
        <section className="adminx-detail-section">
          <h3>Configuração</h3>
          <dl className="adminx-kv">
            <dt>Nome envio</dt><dd>{detail.config.nomeEnvio || "Não configurado"}</dd>
            <dt>Grupo alvo</dt><dd>{detail.config.grupoAlvoNome || detail.config.grupoAlvoJid || "Não configurado"}</dd>
            <dt>Grupo teste</dt><dd>{detail.config.grupoTesteNome || detail.config.grupoTesteJid || "Não configurado"}</dd>
            <dt>Modo alvo</dt><dd>{detail.config.targetDispatchMode}{detail.config.nuclearMode ? " + nuclear" : ""}</dd>
            <dt>Sempre quente</dt><dd>{detail.config.alwaysWarmMode ? `ativo (${detail.config.keepAliveIntervalMs}ms)` : "desligado"}</dd>
            <dt>Modo corrida</dt><dd>{detail.config.alwaysWarmMode ? "aquecimento alvo ate 20000ms quando armado" : "desligado"}</dd>
          </dl>
        </section>
        <section className="adminx-detail-section">
          <h3>Diagnóstico de velocidade</h3>
          <div className="adminx-timeline-metrics">
            <span><b>{formatMs(detail.performanceMetrics?.lastDispatchLatencyMs)}</b><small>detecção</small></span>
            <span><b>{formatMs(detail.performanceMetrics?.lastFirstRelayCallMs)}</b><small>1o relay</small></span>
            <span><b>{formatMs(detail.performanceMetrics?.lastFirstAckMs)}</b><small>1o ACK</small></span>
            <span><b>{formatMs(detail.performanceMetrics?.lastDispatchDurationMs)}</b><small>total</small></span>
          </div>
          {detail.performanceMetrics?.lastDispatchTimeline ? (
            <div className="adminx-dispatch-timeline compact">
              {detail.performanceMetrics.lastDispatchTimeline.events.slice(-8).map((event) => (
                <span className={`adminx-timeline-${event.level || "info"}`} key={event.id}>
                  <b>+{event.offsetMs}ms</b>
                  <strong>{event.label}</strong>
                  {event.detail ? <small>{event.detail}</small> : null}
                </span>
              ))}
            </div>
          ) : <p className="adminx-empty-text">Nenhum disparo diagnosticado ainda.</p>}
        </section>
        <section className="adminx-action-row">
          <button className="button" disabled={busy} type="button" onClick={() => onAction(detail.email, "stop")}>Parar bot</button>
          <button className="button" disabled={busy} type="button" onClick={() => onAction(detail.email, "restart")}>Reiniciar</button>
          <button className="button danger" disabled={busy} type="button" onClick={() => onAction(detail.email, "clear-session")}>Reset sessão</button>
          <button className="button danger" disabled={busy} type="button" onClick={() => onAction(detail.email, "factory-reset")}>Factory reset</button>
        </section>
        <section className="adminx-detail-section">
          <h3>Histórico de login</h3>
          <div className="adminx-log-stack">
            {detail.loginHistory.slice(0, 12).map((event) => (
              <span key={event.id}>{formatDate(event.timestamp)} - {event.ip || "IP não identificado"} - {event.userAgent || "UA vazio"}</span>
            ))}
          </div>
        </section>
        <section className="adminx-detail-section">
          <h3>Logs recentes</h3>
          <div className="adminx-log-stack">
            {detail.logs.slice(0, 50).map((log) => (
              <span className={`adminx-logline adminx-log-${log.level}`} key={log.id}>{formatDate(log.timestamp)} - {uiText(log.message)}</span>
            ))}
          </div>
        </section>
        <section className="adminx-detail-section">
          <h3>Histórico de status do bot</h3>
          <div className="adminx-log-stack">
            {(detail.statusEvents || []).slice(0, 40).map((event) => (
              <span className={`adminx-status-event adminx-status-${event.type}`} key={event.id}>
                {formatDate(event.timestamp)} - {event.type}: {event.message}
              </span>
            ))}
            {!detail.statusEvents?.length ? <span>Nenhum evento de status registrado.</span> : null}
          </div>
        </section>
      </aside>
    </div>
  );
}

export function AdminCommandCenter({ userEmail, onLogout, onEnterClientMode }: AdminCommandCenterProps) {
  const [routes, setRoutes] = useState<AdminRoutesSnapshot>(emptyRoutes);
  const [users, setUsers] = useState<AdminUsersSnapshot>(emptyUsers);
  const [support, setSupport] = useState<AdminSupportMessagesSnapshot>(emptySupport);
  const [imageUsage, setImageUsage] = useState<AdminImageUsageSnapshot>(emptyImageUsage);
  const [usageAmounts, setUsageAmounts] = useState<Record<string, string>>({});
  const dirtyUsageAmounts = useRef(new Set<string>());
  function editUsageAmount(key: string, value: string) {
    dirtyUsageAmounts.current.add(key);
    setUsageAmounts((current) => ({ ...current, [key]: value }));
  }
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [page, setPage] = useState<AdminPage>(() => {
    const requested = new URLSearchParams(window.location.search).get("admin");
    return ["today", "dashboard", "clients", "validations", "reactions", "validated_ai", "validated_routes", "costs", "usage", "history", "logs", "support", "reports", "maintenance", "settings"].includes(requested || "")
      ? requested as AdminPage
      : "dashboard";
  });
  const [clientFilter, setClientFilter] = useState("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const initialReportDates = getAdminDatePreset("current-month");
  const [reportDatePreset, setReportDatePreset] = useState<ReportDatePreset>("current-month");
  const [reportStartDate, setReportStartDate] = useState(initialReportDates.startDate);
  const [reportEndDate, setReportEndDate] = useState(initialReportDates.endDate);
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [logLevel, setLogLevel] = useState<LogLevelFilter>("all");
  const [busy, setBusy] = useState(false);
  const [cloudBackupStatus, setCloudBackupStatus] = useState<AdminCloudBackupStatus>();
  const [cloudBackupBusy, setCloudBackupBusy] = useState(false);
  const [cloudRestoreBusy, setCloudRestoreBusy] = useState(false);
  const [cloudBackupObjects, setCloudBackupObjects] = useState<AdminCloudBackupObject[]>([]);
  const [cloudBackupListError, setCloudBackupListError] = useState("");
  const [selectedCloudBackupKey, setSelectedCloudBackupKey] = useState("");
  const [cloudRestoreStatus, setCloudRestoreStatus] = useState<AdminCloudRestoreStatus>();
  const [portableBackupPassphrase, setPortableBackupPassphrase] = useState("");
  const [portableBackupFile, setPortableBackupFile] = useState<File>();
  const [portableBackupPreview, setPortableBackupPreview] = useState<AdminPortableBackupPreview>();
  const [portableBackupBusy, setPortableBackupBusy] = useState(false);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "fallback">("connecting");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [editor, setEditor] = useState<UserEditorState>();
  const [routeDetail, setRouteDetail] = useState<RouteDispatch>();
  const [clientDetail, setClientDetail] = useState<AdminUserDetail>();
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget>();
  const [rejectRequest, setRejectRequest] = useState<RejectRequest>();
  const [rejectReason, setRejectReason] = useState("Sem reação válida");
  const [leaders, setLeaders] = useState<LeaderContact[]>([]);
  const [leaderDraft, setLeaderDraft] = useState<LeaderContact>({ name: "", phone: "" });
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [usageView, setUsageView] = useState<"pending" | "history">("pending");
  const [prepaidDrafts, setPrepaidDrafts] = useState<Record<string, string>>({});
  const [dueDayDrafts, setDueDayDrafts] = useState<Record<string, string>>({});
  const [routeCadenceDrafts, setRouteCadenceDrafts] = useState<Record<string, string>>({});

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function applySnapshot(snapshot: AdminMonitorSnapshot) {
    const safeSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {} as AdminMonitorSnapshot;
    const nextRoutes = safeSnapshot.routes && Array.isArray(safeSnapshot.routes.routes) ? safeSnapshot.routes : emptyRoutes;
    const nextUsers = safeSnapshot.users && Array.isArray(safeSnapshot.users.users) ? safeSnapshot.users : undefined;
    const nextSupport = safeSnapshot.support && Array.isArray(safeSnapshot.support.messages) ? safeSnapshot.support : emptySupport;
    const nextUsage = safeSnapshot.imageUsage || emptyImageUsage;
    setRoutes(nextRoutes);
    if (nextUsers) setUsers(nextUsers);
    setSupport(nextSupport);
    setImageUsage(nextUsage);
    setUsageAmounts((current) => mergeUsageAmounts(current, nextUsage, dirtyUsageAmounts.current));
    setLogs(Array.isArray(safeSnapshot.logs) ? safeSnapshot.logs : []);
    setSelectedRoutes((current) => current.filter((id) => nextRoutes.routes.some((route) => route.id === id && routeDecision(route) === "pending")));
    setLeaders(Array.isArray(safeSnapshot.leaders) ? safeSnapshot.leaders : []);
    setStreamState(nextUsers ? "live" : "fallback");
    setError(nextUsers ? "" : "O servidor enviou um snapshot incompleto; mantendo os dados anteriores e tentando novamente.");
  }

  function refresh() {
    getAdminMonitor()
      .then(applySnapshot)
      .catch((nextError) => {
        if (isAuthError(nextError)) {
          onLogout();
          return;
        }
        setStreamState("fallback");
        setError(nextError instanceof Error ? nextError.message : "Falha ao carregar painel admin.");
      });
  }

  async function refreshCloudBackupStatus() {
    try {
      setCloudBackupStatus(await getAdminCloudBackupStatus());
    } catch (nextError) {
      if (isAuthError(nextError)) onLogout();
    }
  }

  async function refreshCloudBackupObjects() {
    try {
      const result = await getAdminCloudBackupObjects();
      setCloudBackupObjects(result.objects);
      setCloudBackupListError("");
      setSelectedCloudBackupKey((current) => result.objects.some((item) => item.key === current)
        ? current
        : "");
    } catch (nextError) {
      setCloudBackupListError(nextError instanceof Error ? nextError.message : "Não foi possível listar os snapshots do R2.");
    }
  }

  async function refreshCloudRestoreStatus() {
    try {
      setCloudRestoreStatus(await getAdminCloudRestoreStatus());
    } catch (nextError) {
      if (isAuthError(nextError)) onLogout();
    }
  }

  const restorePhaseLabels: Record<AdminCloudRestoreStatus["phase"], string> = {
    idle: "Aguardando",
    listing: "Localizando backup",
    waiting_backup: "Aguardando backup atual",
    downloading: "Baixando snapshot",
    validating: "Validando integridade",
    ready: "Pronto para aplicar",
    applying: "Aplicando e reiniciando",
    completed: "Concluída",
    failed: "Falhou"
  };

  async function createCloudBackupNow() {
    setCloudBackupBusy(true);
    try {
      const result = await triggerAdminCloudBackup();
      setCloudBackupStatus(result.status);
      showToast("Backup solicitado; o status será atualizado automaticamente.");
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : "Não foi possível iniciar o backup.");
    } finally {
      setCloudBackupBusy(false);
    }
  }

  async function restoreCloudBackupNow() {
    const selected = cloudBackupObjects.find((item) => item.key === selectedCloudBackupKey);
    if (!selected) {
      showToast("Selecione um snapshot listado no R2 antes de restaurar.");
      return;
    }
    const confirmed = window.prompt(
      `ATENÇÃO: será restaurado ${selected.key} (${formatBackupSize(selected.size)}), substituindo os dados atuais. Eles serão preservados em uma pasta de segurança. O serviço reiniciará. Digite RESTAURAR DADOS para continuar.`
    );
    if (confirmed !== "RESTAURAR DADOS") return;
    if (!window.confirm("Última confirmação: restaurar este snapshot e reiniciar o serviço agora?")) return;
    setCloudRestoreBusy(true);
    try {
      const result = await restoreAdminCloudBackup(selected.key);
      showToast(result.message);
      setCloudRestoreBusy(false);
      void refreshCloudRestoreStatus();
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : "Não foi possível validar o backup para restauração.");
      setCloudRestoreBusy(false);
      void refreshCloudRestoreStatus();
    }
  }

  async function exportPortableBackupNow() {
    if (portableBackupPassphrase.length < 12) {
      showToast("Crie uma senha com pelo menos 12 caracteres e guarde-a fora do site.");
      return;
    }
    setPortableBackupBusy(true);
    try {
      const result = await exportAdminPortableBackup(portableBackupPassphrase);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast("Arquivo pronto. Salve em Arquivos no iPhone e guarde a senha.");
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : "Não foi possível exportar o backup.");
    } finally {
      setPortableBackupBusy(false);
    }
  }

  async function previewPortableBackupNow() {
    if (!portableBackupFile) {
      showToast("Escolha primeiro o arquivo .botbackup.");
      return;
    }
    if (portableBackupPassphrase.length < 12) {
      showToast("Digite a senha usada quando o arquivo foi exportado.");
      return;
    }
    setPortableBackupBusy(true);
    setPortableBackupPreview(undefined);
    try {
      setPortableBackupPreview(await previewAdminPortableBackup(portableBackupFile, portableBackupPassphrase));
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : "Não foi possível validar o arquivo.");
    } finally {
      setPortableBackupBusy(false);
    }
  }

  async function applyPortableBackupNow() {
    if (!portableBackupPreview) return;
    const { clients: clientCount, routes, validatedRoutes } = portableBackupPreview.summary;
    if (!window.confirm(`O arquivo tem ${clientCount} cliente(s), ${routes} rota(s) (${validatedRoutes} validadas) e ${portableBackupPreview.summary.files} arquivo(s). Os dados atuais deste site serão substituídos; o sistema guarda uma cópia de segurança antes da troca e reinicia. Continuar?`)) return;
    setPortableBackupBusy(true);
    try {
      const result = await applyAdminPortableBackup(portableBackupPreview.ticket);
      showToast(result.message);
      setPortableBackupPreview(undefined);
    } catch (nextError) {
      showToast(nextError instanceof Error ? nextError.message : "Não foi possível aplicar o arquivo.");
    } finally {
      setPortableBackupBusy(false);
    }
  }

  useEffect(() => {
    return subscribeAdminMonitor(applySnapshot, (nextError) => {
      setStreamState("fallback");
      if (isAuthError(nextError)) onLogout();
    });
  }, []);

  useEffect(() => {
    if (page !== "settings") return;
    void refreshCloudBackupStatus();
    void refreshCloudBackupObjects();
    void refreshCloudRestoreStatus();
    const timer = window.setInterval(() => void refreshCloudBackupStatus(), 10_000);
    const restoreTimer = window.setInterval(() => void refreshCloudRestoreStatus(), 1_000);
    const objectsTimer = window.setInterval(() => void refreshCloudBackupObjects(), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(restoreTimer);
      window.clearInterval(objectsTimer);
    };
  }, [page]);

  const safeAdminUsers = Array.isArray(users?.users) ? users.users : [];
  const clients = useMemo(() => safeAdminUsers.filter((user) => user.role === "client"), [safeAdminUsers]);
  const clientModeTarget = useMemo(() => {
    const selectedClient = clientFilter === "all"
      ? undefined
      : clients.find((client) => client.email === clientFilter);
    if (selectedClient) return selectedClient;
    return clients.find((client) => /(^|[._+@-])(test|teste)([._+@-]|$)/i.test(client.email));
  }, [clientFilter, clients]);
  const period = dateRangeMs(datePreset);

  function applyReportDatePreset(preset: AdminDatePreset) {
    const range = getAdminDatePreset(preset);
    setReportDatePreset(preset);
    setReportStartDate(range.startDate);
    setReportEndDate(range.endDate);
  }

  async function enterClientMode() {
    if (!clientModeTarget) return;
    setBusy(true);
    setError("");
    try {
      await onEnterClientMode(clientModeTarget.email);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui abrir o modo cliente.");
      setBusy(false);
    }
  }

  const visibleRoutes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return routes.routes.filter((route) => {
      const created = new Date(route.createdAt).getTime();
      const clientOk = clientFilter === "all" || route.clientEmail === clientFilter;
      const dateOk = page === "reports" || (created >= period.start && created <= period.end);
      const decision = routeDecision(route);
      const decisionOk =
        decisionFilter === "all" ||
        decisionFilter === decision ||
        (decisionFilter === "leader" && hasAnyReaction(route)) ||
        (decisionFilter === "removed" && route.lastReactionState?.status === "removed");
      const modeOk =
        modeFilter === "all" ||
        route.mode === modeFilter ||
        (modeFilter === "ocr" && Boolean(route.ocr)) ||
        (modeFilter === "manual" && route.trigger === "manual" && !route.ocr) ||
        (modeFilter === "automatic" && route.trigger === "automatic" && !route.ocr) ||
        (["warmup", "simulation"].includes(modeFilter) && route.trigger === modeFilter);
      const queryOk = !query || [
        route.clientEmail,
        route.groupName,
        route.groupJid,
        triggerLabel(route),
        route.ocr?.text,
        route.ocr?.line,
        route.ocr?.route,
        ...route.messages,
        ...route.reactions.flatMap((reaction) => [reaction.senderPhone, reaction.leaderName || "", reaction.emoji])
      ].some((item) => String(item || "").toLowerCase().includes(query));
      return clientOk && dateOk && decisionOk && modeOk && queryOk;
    });
  }, [clientFilter, decisionFilter, modeFilter, page, period.end, period.start, routes.routes, search]);

  const reportRoutes = useMemo(() => visibleRoutes.filter((route) =>
    isDateInsideAdminRange(route.createdAt, reportStartDate, reportEndDate)
  ), [reportEndDate, reportStartDate, visibleRoutes]);
  const reportValidatedCount = reportRoutes.filter((route) => routeDecision(route) === "validated").length;
  const reportValidationRate = reportRoutes.length ? Math.round((reportValidatedCount / reportRoutes.length) * 100) : 0;

  const visibleLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return logs.filter((log) => {
      const clientOk = clientFilter === "all" || log.clientEmail === clientFilter;
      const levelOk = logLevel === "all" || log.level === logLevel;
      const queryOk = !query || [log.clientEmail, log.level, log.message].some((item) => String(item).toLowerCase().includes(query));
      return clientOk && levelOk && queryOk;
    });
  }, [clientFilter, logLevel, logs, search]);

  const visibleSupport = useMemo(
    () => support.messages.filter((message) => clientFilter === "all" || message.email === clientFilter),
    [clientFilter, support.messages]
  );

  const realValidationRoutes = visibleRoutes.filter(isRealValidationRoute);
  const otherHistoryRoutes = visibleRoutes.filter((route) => !isRealValidationRoute(route));
  const validationReviewRoutes = visibleRoutes.filter((route) => needsRealReview(route) && !route.ocr);
  const validationPendingRoutes = realValidationRoutes.filter((route) => routeDecision(route) === "pending" && !route.ocr);
  const reactedImageRoutes = visibleRoutes.filter((route) => Boolean(route.ocr) && hasAnyReaction(route));
  const pendingReactedImageRoutes = reactedImageRoutes.filter((route) => routeDecision(route) === "pending");
  const decidedReactedImageRoutes = reactedImageRoutes.filter((route) => routeDecision(route) !== "pending");
  const validatedImageRoutes = visibleRoutes.filter((route) =>
    Boolean(route.ocr) && routeDecision(route) === "validated" && route.decisionSource === "leader_reaction_1h"
  );
  const validationLeaderRoutes = realValidationRoutes.filter(hasLeaderReaction);
  const validatedRealRoutes = realValidationRoutes.filter((route) => routeDecision(route) === "validated");
  const nonValidationRoutes = visibleRoutes.filter((route) => !isRealValidationRoute(route));
  const removedReactionRoutes = realValidationRoutes.filter((route) => route.lastReactionState?.status === "removed");
  const todayRange = dateRangeMs("today");
  const todayRoutes = routes.routes.filter((route) => {
    const created = new Date(route.createdAt).getTime();
    return created >= todayRange.start && created <= todayRange.end;
  });
  const todayValidationRoutes = todayRoutes.filter(isRealValidationRoute);
  const todayReviewRoutes = todayRoutes.filter(needsRealReview);
  const staleClients = clients.filter((client) => {
    if (client.presenceStatus === "online" || client.blocked) return false;
    const lastSeen = client.lastSeenAt ? new Date(client.lastSeenAt).getTime() : 0;
    return !lastSeen || Date.now() - lastSeen > 1000 * 60 * 60 * 6;
  });
  const armedLongRoutes = clients.filter((client) => (client.performanceMetrics?.armedIdleMs || 0) > 1000 * 60 * 30 && client.monitoringEnabled);
  const notAcceptableLogs = logs.filter((log) => /not-acceptable/i.test(log.message));
  const smartAlerts = [
    ...removedReactionRoutes.slice(0, 8).map((route) => ({ id: `removed-${route.id}`, tone: "yellow" as const, title: "Reação removida", detail: `${route.clientEmail} - ${route.groupName || route.groupJid}` })),
    ...staleClients.slice(0, 8).map((client) => ({ id: `stale-${client.email}`, tone: "blue" as const, title: "Cliente sem conectar", detail: `${client.email} - último visto ${formatShort(client.lastSeenAt)}` })),
    ...armedLongRoutes.slice(0, 8).map((client) => ({ id: `armed-${client.email}`, tone: "yellow" as const, title: "Bot armado há muito tempo", detail: `${client.email} - ${formatDuration(client.performanceMetrics?.armedIdleMs || 0)}` })),
    ...notAcceptableLogs.slice(0, 8).map((log) => ({ id: `na-${log.clientEmail}-${log.id}`, tone: "red" as const, title: "Falha not-acceptable", detail: uiText(`${log.clientEmail} - ${log.message}`) })),
    ...support.messages.filter((message) => !message.read).slice(0, 8).map((message) => ({ id: `support-${message.id}`, tone: "red" as const, title: "Suporte não lido", detail: `${message.email} - ${message.message}` }))
  ].slice(0, 18);
  const importantNotifications = [
    ...(pendingReactedImageRoutes.length ? [{ id: "reactions", title: "Imagens reagidas para decidir", detail: `${pendingReactedImageRoutes.length} análise(s) precisam da sua decisão.`, target: "reactions" as AdminPage }] : []),
    ...(validationReviewRoutes.length ? [{ id: "validations", title: "Rotas aguardando validação", detail: `${validationReviewRoutes.length} rota(s) precisam da sua decisão.`, target: "validations" as AdminPage }] : []),
    ...(imageUsage.totals.pending ? [{ id: "usage", title: "Análises aguardando cobrança", detail: `${imageUsage.totals.pending} análise(s) ainda precisam ser classificadas.`, target: "usage" as AdminPage }] : []),
    ...(support.unread ? [{ id: "support", title: "Mensagens de suporte", detail: `${support.unread} mensagem(ns) ainda não foram lidas.`, target: "support" as AdminPage }] : []),
    ...logs.filter((log) => log.level === "error" && Date.now() - new Date(log.timestamp).getTime() < 24 * 60 * 60 * 1000).slice(-5).reverse().map((log) => ({ id: `error-${log.id}`, title: "Erro recente no bot", detail: uiText(`${log.clientEmail}: ${log.message}`), target: "logs" as AdminPage }))
  ].slice(0, 10);
  const leaderPhones = useMemo(() => new Set(leaders.map((leader) => normalizeAdminText(leader.phone).replace(/\D/g, ""))), [leaders]);
  const leaderCandidates = useMemo(() => {
    const candidates = new Map<string, { phone: string; name: string; count: number; lastAt: string }>();
    routes.routes.forEach((route) => {
      route.reactions.forEach((reaction) => {
        const phone = String(reaction.senderPhone || reaction.senderIdentifiers?.[0] || "").replace(/\D/g, "");
        if (!phone || leaderPhones.has(phone) || reaction.isAdmin) return;
        const current = candidates.get(phone);
        const name = reaction.leaderName || `Contato ${phone.slice(-4)}`;
        const lastAt = reaction.timestamp || route.updatedAt || route.createdAt;
        candidates.set(phone, {
          phone,
          name: current?.name || name,
          count: (current?.count || 0) + 1,
          lastAt: !current || new Date(lastAt).getTime() > new Date(current.lastAt).getTime() ? lastAt : current.lastAt
        });
      });
    });
    return Array.from(candidates.values())
      .sort((a, b) => b.count - a.count || new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())
      .slice(0, 8);
  }, [leaderPhones, routes.routes]);
  const onlineClients = clients.filter((client) => client.presenceStatus === "online").length;
  const connectedBots = clients.filter((client) => ["connected", "connecting", "waiting_qr", "reconnecting"].includes(client.botStatus || "")).length;
  const activeBots = clients.filter((client) => client.monitoringEnabled).length;
  const liveClients = clients
    .map((client) => {
      const clientRoutes = routes.routes.filter((route) => route.clientEmail === client.email);
      const latestRoute = clientRoutes[0];
      const recentErrors = logs.filter((log) => log.clientEmail === client.email && log.level === "error").slice(0, 3);
      const lastSeenMs = client.lastSeenAt ? new Date(client.lastSeenAt).getTime() : 0;
      const stale = !client.blocked && (!lastSeenMs || Date.now() - lastSeenMs > 1000 * 60 * 30);
      const needsAttention = Boolean(
        client.blocked ||
        stale ||
        recentErrors.length ||
        (client.monitoringEnabled && client.botStatus !== "connected")
      );
      const statusRank = needsAttention ? 0 : client.monitoringEnabled ? 1 : client.presenceStatus === "online" ? 2 : 3;
      return { client, latestRoute, recentErrors, stale, needsAttention, statusRank };
    })
    .sort((a, b) => a.statusRank - b.statusRank || a.client.email.localeCompare(b.client.email));
  const validatedCount = visibleRoutes.filter((route) => routeDecision(route) === "validated").length;
  const allValidatedRoutes = visibleRoutes.filter((route) => routeDecision(route) === "validated");
  const validationRate = visibleRoutes.length ? Math.round((validatedCount / visibleRoutes.length) * 100) : 0;
  const ocrRoutes = visibleRoutes.filter((route) => Boolean(route.ocr));
  const sentRoutes = visibleRoutes.filter((route) => route.confirmedCount > 0);
  const reactedRoutes = visibleRoutes.filter(hasAnyReaction);
  const rejectedRoutes = visibleRoutes.filter((route) => routeDecision(route) === "rejected");
  const pendingRoutes = visibleRoutes.filter((route) => routeDecision(route) === "pending");
  const notAcceptableRoutes = visibleRoutes.filter((route) => (route.dispatchTimeline?.notAcceptableCount || 0) > 0);
  const averageFirstAck = averageNumber(visibleRoutes.map((route) => route.dispatchTimeline?.firstAckMs || 0).filter(Boolean));
  const p95FirstAck = routeP95(visibleRoutes.map((route) => route.dispatchTimeline?.firstAckMs || 0).filter(Boolean));
  const topRouteLabels = topLabels(visibleRoutes, 5);
  const visibleUsageEntries = imageUsage.entries.filter((entry) => {
    const clientOk = clientFilter === "all" || entry.clientEmail === clientFilter;
    const query = search.trim().toLowerCase();
    const queryOk = !query || [entry.clientEmail, entry.route, entry.bairro, entry.gaiola, entry.result, entry.decision]
      .some((item) => String(item || "").toLowerCase().includes(query));
    const decisionOk = usageView === "history" || entry.decision === "pending";
    return clientOk && queryOk && decisionOk;
  });
  const routeByAnalysisId = useMemo(() => new Map(
    routes.routes.filter((route) => route.ocr?.analysisId).map((route) => [route.ocr!.analysisId!, route])
  ), [routes.routes]);
  const pricingClients = clients.map((client) => imageUsage.clients.find((item) => item.clientEmail === client.email) || {
    clientEmail: client.email,
    month: imageUsage.month,
    total: 0,
    pending: 0,
    billable: 0,
    excluded: 0,
    detected: 0,
    amountCents: 0,
    defaultAmountCents: 70,
    billAllValidatedRoutes: true,
    routePriceCents: 70,
    prepaidRoutesRemaining: 0,
    dueDay: 15,
    paymentEveryRoutes: /fernando/i.test(client.email) ? 10 : 0,
    unpaidRoutes: 0
  });
  const visibleDebt = clientFilter === "all"
    ? imageUsage.totals.amountCents
    : imageUsage.clients.find((client) => client.clientEmail === clientFilter)?.amountCents || 0;

  const clientIntelligence = useMemo(() => {
    const now = Date.now();
    const currentDayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

    return clients.map((client) => {
      const clientRoutes = visibleRoutes.filter((route) => route.clientEmail === client.email);
      const valid = clientRoutes.filter((route) => routeDecision(route) === "validated").length;
      const rejected = clientRoutes.filter((route) => routeDecision(route) === "rejected").length;
      const pending = clientRoutes.filter((route) => routeDecision(route) === "pending").length;
      const sent = clientRoutes.filter((route) => route.confirmedCount > 0).length;
      const leader = clientRoutes.filter(hasLeaderReaction).length;
      const removed = clientRoutes.filter((route) => route.lastReactionState?.status === "removed").length;
      const notAcceptable = clientRoutes.reduce((total, route) => total + (route.dispatchTimeline?.notAcceptableCount || 0), 0);
      const activeDays = uniqueDays(clientRoutes);
      const validation = clientRoutes.length ? Math.round((valid / clientRoutes.length) * 100) : 0;
      const pickup = clientRoutes.length ? Math.round((sent / clientRoutes.length) * 100) : 0;
      const paceProjection = Math.round((clientRoutes.length / Math.max(1, currentDayOfMonth)) * daysInMonth);
      const recentSeen = client.lastSeenAt ? now - new Date(client.lastSeenAt).getTime() < 1000 * 60 * 60 * 2 : false;
      const score = Math.max(0, Math.min(100,
        35 +
        validation * 0.28 +
        pickup * 0.22 +
        Math.min(15, activeDays * 2) +
        (client.monitoringEnabled ? 10 : 0) +
        (recentSeen ? 5 : 0) -
        rejected * 3 -
        pending * 1.5 -
        removed * 4 -
        notAcceptable * 1.5
      ));
      const risk =
        !client.monitoringEnabled ? "Bot parado" :
        notAcceptable >= 3 ? "WhatsApp recusando" :
        pending >= 5 ? "Validação acumulada" :
        removed > 0 ? "Reação removida" :
        score >= 75 ? "Saudável" :
        "Atenção";
      return {
        client,
        routes: clientRoutes,
        valid,
        rejected,
        pending,
        sent,
        leader,
        removed,
        notAcceptable,
        activeDays,
        validation,
        pickup,
        paceProjection,
        score: Math.round(score),
        risk,
        topRoutes: topLabels(clientRoutes, 3),
        lastRoute: [...clientRoutes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
      };
    }).sort((a, b) => b.score - a.score || b.valid - a.valid || b.routes.length - a.routes.length);
  }, [clients, period.end, period.start, visibleRoutes]);

  const criticalClients = clientIntelligence
    .filter((item) => item.risk !== "Saudável" || item.score < 65)
    .sort((a, b) => a.score - b.score)
    .slice(0, 8);
  const bestClients = clientIntelligence.slice(0, 6);
  const projectedMonthRoutes = clientIntelligence.reduce((total, item) => total + item.paceProjection, 0);
  const funnelSteps = [
    { label: "Detectadas", value: visibleRoutes.length },
    { label: "Enviadas", value: sentRoutes.length },
    { label: "Com reação", value: reactedRoutes.length },
    { label: "Validadas", value: validatedCount },
    { label: "Rejeitadas", value: rejectedRoutes.length }
  ];

  const hourlyChart = useMemo(() => {
    const slots = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    visibleRoutes.forEach((route) => {
      slots[new Date(route.createdAt).getHours()].count += 1;
    });
    const max = Math.max(1, ...slots.map((slot) => slot.count));
    return slots.map((slot) => ({ ...slot, height: Math.max(5, Math.round((slot.count / max) * 100)) }));
  }, [visibleRoutes]);

  async function saveUser(next = editor) {
    if (!next) return;
    setBusy(true);
    try {
      const result = await saveAdminUser(next);
      if (result && Array.isArray(result.users)) setUsers(result);
      else refresh();
      setEditor(undefined);
      showToast("Usuário salvo.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar usuário.");
    } finally {
      setBusy(false);
    }
  }

  async function openClient(email: string) {
    try {
      setClientDetail(await getAdminUserDetail(email));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui abrir cliente.");
    }
  }

  async function decideRoute(routeId: string, decision: "validate" | "reject", reason?: string) {
    setBusy(true);
    try {
      const nextRoutes = decision === "validate" ? await validateAdminRoute(routeId) : await rejectAdminRoute(routeId, reason);
      setRoutes(nextRoutes);
      setSelectedRoutes((current) => current.filter((id) => id !== routeId));
      setRouteDetail(undefined);
      showToast(decision === "validate" ? "Rota validada." : "Rota rejeitada.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui atualizar rota.");
    } finally {
      setBusy(false);
    }
  }

  async function updateImageUsage(id: string, decision: "pending" | "billable" | "excluded") {
    setBusy(true);
    try {
      const next = await decideImageUsage(id, { decision, amountCents: parseMoneyInput(usageAmounts[id] || "0") });
      dirtyUsageAmounts.current.delete(id);
      setImageUsage(next);
      showToast(decision === "billable" ? "Imagem e rota validadas para cobrança." : decision === "excluded" ? "Imagem e rota excluídas da pendência." : "Análise devolvida para revisão.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui atualizar o consumo.");
    } finally {
      setBusy(false);
    }
  }

  async function updateImagePricing(clientEmail: string) {
    setBusy(true);
    try {
      const next = await saveImagePricing(clientEmail, parseMoneyInput(usageAmounts[`client:${clientEmail}`] || "0"));
      dirtyUsageAmounts.current.delete(`client:${clientEmail}`);
      setImageUsage(next);
      showToast("Valor padrão atualizado.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar o valor padrão.");
    } finally {
      setBusy(false);
    }
  }

  async function updateImageMonthlyTotal(clientEmail: string) {
    setBusy(true);
    try {
      const next = await saveImageMonthlyTotal(clientEmail, parseMoneyInput(usageAmounts[`total:${clientEmail}`] || "0"), imageUsage.month);
      dirtyUsageAmounts.current.delete(`total:${clientEmail}`);
      setImageUsage(next);
      showToast("Total mensal do cliente atualizado.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar o total mensal.");
    } finally {
      setBusy(false);
    }
  }

  async function updateRouteBillingMode(clientEmail: string, enabled: boolean) {
    setBusy(true);
    try {
      const next = await saveRouteBillingMode(clientEmail, enabled);
      setImageUsage(next);
      showToast(enabled ? "Todas as rotas validadas deste cliente entrarão no consumo." : "Cobrança limitada novamente às análises de imagem.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar o controle de cobrança.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFinanceSettings(clientEmail: string, action: "price" | "credits" | "due" | "cadence") {
    setBusy(true);
    try {
      const payload = action === "price"
        ? { routePriceCents: parseMoneyInput(usageAmounts[`client:${clientEmail}`] ?? ((pricingClients.find((client) => client.clientEmail === clientEmail)?.routePriceCents || 70) / 100).toFixed(2)) }
        : action === "credits"
          ? { prepaidRoutesRemaining: Math.max(0, Math.floor(Number(prepaidDrafts[clientEmail] ?? pricingClients.find((client) => client.clientEmail === clientEmail)?.prepaidRoutesRemaining) || 0)) }
          : action === "due"
            ? { dueDay: Math.max(1, Math.min(31, Math.floor(Number(dueDayDrafts[clientEmail]) || 15))) }
            : { paymentEveryRoutes: Math.max(0, Math.min(10_000, Math.floor(Number(routeCadenceDrafts[clientEmail] ?? pricingClients.find((client) => client.clientEmail === clientEmail)?.paymentEveryRoutes) || 0))) };
      const next = await saveClientFinance(clientEmail, payload);
      setImageUsage(next);
      showToast(action === "credits" ? "Quantidade de rotas antecipadas atualizada." : action === "due" ? "Vencimento atualizado." : action === "cadence" ? "Ciclo de cobrança atualizado." : "Preço por rota salvo.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui atualizar o financeiro.");
    } finally {
      setBusy(false);
    }
  }

  async function clearPrepaidRoutes(clientEmail: string) {
    if (!window.confirm(`Zerar o saldo de rotas antecipadas de ${clientEmail}?`)) return;
    setBusy(true);
    try {
      const next = await saveClientFinance(clientEmail, { prepaidRoutesRemaining: 0 });
      setImageUsage(next);
      setPrepaidDrafts((draft) => ({ ...draft, [clientEmail]: "0" }));
      showToast("Saldo de rotas antecipadas zerado.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "NÃ£o consegui zerar o saldo antecipado.");
    } finally {
      setBusy(false);
    }
  }

  async function markClientPaid(clientEmail: string) {
    if (!window.confirm(`Registrar o pagamento de ${clientEmail} e zerar o saldo em aberto?`)) return;
    setBusy(true);
    try {
      setImageUsage(await registerClientPayment(clientEmail));
      showToast("Pagamento registrado; histórico preservado.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui registrar o pagamento.");
    } finally {
      setBusy(false);
    }
  }

  function requestReject(routeIds: string[], title = "Rejeitar rota") {
    setRejectRequest({ routeIds, title });
    setRejectReason("");
  }

  async function confirmReject() {
    if (!rejectRequest) return;
    if (rejectRequest.routeIds.length === 1) {
      await decideRoute(rejectRequest.routeIds[0], "reject", rejectReason);
    } else {
      setBusy(true);
      try {
        const nextRoutes = await bulkDecideAdminRoutes({ routeIds: rejectRequest.routeIds, decision: "reject", reason: rejectReason });
        setRoutes(nextRoutes);
        setSelectedRoutes([]);
        showToast(`${nextRoutes.changed} rota(s) rejeitada(s).`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Ação em lote falhou.");
      } finally {
        setBusy(false);
      }
    }
    setRejectRequest(undefined);
  }

  async function decideSelected(decision: "validate" | "reject") {
    const allowedIds = page === "reactions"
      ? selectedRoutes.filter((routeId) => pendingReactedImageRoutes.some((route) => route.id === routeId))
      : page === "validations"
      ? selectedRoutes.filter((routeId) => realValidationRoutes.some((route) => route.id === routeId))
      : selectedRoutes;
    if (!allowedIds.length) {
      showToast(page === "reactions" ? "Selecione análises reagidas que ainda estejam pendentes." : "Selecione rotas reais do grupo de motoristas.");
      return;
    }
    setBusy(true);
    try {
      if (decision === "reject") {
        setBusy(false);
        requestReject(allowedIds, "Rejeitar rotas selecionadas");
        return;
      }
      const nextRoutes = await bulkDecideAdminRoutes({ routeIds: allowedIds, decision });
      setRoutes(nextRoutes);
      setSelectedRoutes([]);
      showToast(`${nextRoutes.changed} rota(s) atualizada(s).`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Ação em lote falhou.");
    } finally {
      setBusy(false);
    }
  }

  async function readSupport(id: string) {
    try {
      setSupport(await markSupportMessageRead(id));
      showToast("Mensagem marcada como lida.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui marcar mensagem.");
    }
  }

  async function runClientAction(email: string, action: string) {
    setBusy(true);
    try {
      setClientDetail(await runAdminUserBotAction(email, action));
      showToast("Ação enviada para o bot do cliente.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui executar ação no cliente.");
    } finally {
      setBusy(false);
    }
  }

  async function cleanup(target: CleanupTarget) {
    if (cleanupTarget !== target) {
      setCleanupTarget(target);
      return;
    }
    setBusy(true);
    try {
      applySnapshot(await clearAdminMaintenance({ target, clientEmail: clientFilter === "all" ? undefined : clientFilter }));
      setCleanupTarget(undefined);
      showToast("Limpeza concluída.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui limpar dados.");
    } finally {
      setBusy(false);
    }
  }

  async function enableNotifications() {
    setBusy(true);
    try {
      await enableWebPushNotifications();
      setError("");
      showToast("Alertas em segundo plano ativados.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui ativar as notificações.");
    } finally {
      setBusy(false);
    }
  }

  function resetAdminFilters() {
    setClientFilter("all");
    setDatePreset("30d");
    setSearch("");
    setDecisionFilter("all");
    setModeFilter("all");
    setLogLevel("all");
    showToast("Filtros resetados.");
  }

  async function saveLeader(event: FormEvent) {
    event.preventDefault();
    await saveLeaderContact(leaderDraft);
  }

  async function saveLeaderContact(contact: LeaderContact) {
    setBusy(true);
    try {
      const response = await saveAdminLeader(contact);
      setLeaders(response.leaders);
      setLeaderDraft({ name: "", phone: "" });
      showToast("Líder salvo.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar líder.");
    } finally {
      setBusy(false);
    }
  }

  async function removeLeader(phone: string) {
    setBusy(true);
    try {
      const response = await removeAdminLeader(phone);
      setLeaders(response.leaders);
      showToast("Líder removido.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui remover líder.");
    } finally {
      setBusy(false);
    }
  }

  function exportRoutes(format: "csv" | "json", sourceRoutes = visibleRoutes) {
    const rows = sourceRoutes.map((route) => ({
      id: route.id,
      cliente: route.clientEmail,
      grupo: route.groupName || route.groupJid,
      origem: triggerLabel(route),
      decisao: routeDecision(route),
      tipo_validacao: routeDecisionLabel(route),
      responsavel_validacao: route.validationLeaderName || route.validatedBy || route.rejectedBy || "",
      reacao_iniciada_em: route.validationReactionAt || "",
      envio: `${route.confirmedCount}/${route.totalCount}`,
      reacao_final: reactionFinalLabel(route),
      mensagens: route.messages.join(" | "),
      criado_em: route.createdAt
    }));
    if (format === "json") {
      downloadText("rotas-admin.json", JSON.stringify(sourceRoutes, null, 2), "application/json;charset=utf-8");
      return;
    }
    downloadText("rotas-admin.csv", toCsv(rows), "text/csv;charset=utf-8");
  }

  function toggleSelected(routeId: string) {
    setSelectedRoutes((current) => current.includes(routeId) ? current.filter((id) => id !== routeId) : [...current, routeId]);
  }

  const pages: Array<{ id: AdminPage; label: string; Icon: typeof Activity; badge?: number }> = [
    { id: "today", label: "Hoje", Icon: Clock3, badge: todayRoutes.length },
    { id: "operations", label: "Ao vivo", Icon: Activity, badge: liveClients.filter((item) => item.needsAttention).length },
    { id: "dashboard", label: "Dashboard", Icon: Gauge },
    { id: "clients", label: "Clientes", Icon: Users, badge: onlineClients },
    { id: "validations", label: "Validações", Icon: ShieldCheck, badge: validationReviewRoutes.length },
    { id: "reactions", label: "Reações IA", Icon: MessageSquareText, badge: pendingReactedImageRoutes.length },
    { id: "validated_ai", label: "Rotas IA válidas", Icon: CheckCircle2, badge: validatedImageRoutes.length },
    { id: "validated_routes", label: "Rotas validadas", Icon: ShieldCheck, badge: validatedCount },
    { id: "costs", label: "Custos", Icon: CircleDollarSign, badge: imageUsage.totals.unpaidRoutes },
    { id: "usage", label: "Análises", Icon: BrainCircuit, badge: imageUsage.totals.pending },
    { id: "history", label: "Histórico", Icon: History },
    { id: "logs", label: "Logs", Icon: Activity, badge: visibleLogs.filter((log) => log.level === "error").length },
    { id: "support", label: "Suporte", Icon: Inbox, badge: support.unread },
    { id: "reports", label: "Relatórios", Icon: FileJson },
    { id: "maintenance", label: "Manutenção", Icon: Trash2 },
    { id: "settings", label: "Config", Icon: Settings }
  ];

  return (
    <main className="adminx-shell">
      <aside className="adminx-sidebar">
        <div className="adminx-brand">
          <Bot size={24} />
          <div>
            <strong>Bot Rotas</strong>
            <small>Admin Command</small>
          </div>
        </div>
        <nav>
          {pages.map(({ id, label, Icon, badge }) => (
            <button className={page === id ? "active" : ""} key={id} type="button" onClick={() => { setPage(id); if (id === "validations" || id === "reactions") setDecisionFilter("all"); }}>
              <Icon size={19} />
              <span>{label}</span>
              {badge ? <b>{badge}</b> : null}
            </button>
          ))}
        </nav>
        <button className="adminx-logout" type="button" onClick={onLogout}>
          <LogOut size={18} />
          {userEmail}
        </button>
      </aside>

      <section className="adminx-main">
        <header className="adminx-topbar">
          <div>
            <p>Central de comando</p>
            <h1>{pages.find((item) => item.id === page)?.label}</h1>
          </div>
          <div className="adminx-global-filters">
            <button className="adminx-debt-chip" type="button" onClick={() => setPage("usage")} title="Abrir controle financeiro">
              <CircleDollarSign size={19} />
              <span><small>{clientFilter === "all" ? "Total a receber" : "Cliente deve"}</small><strong>{formatMoney(visibleDebt)}</strong></span>
            </button>
            <label>
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente, grupo, análise, log..." />
            </label>
            <select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)}>
              <option value="all">Todos os clientes</option>
              {clients.map((client) => <option key={client.email} value={client.email}>{client.email}</option>)}
            </select>
            {page !== "reports" ? <select value={datePreset} onChange={(event) => setDatePreset(event.target.value as DatePreset)}>
              <option value="today">Hoje</option>
              <option value="7d">7 dias</option>
              <option value="30d">30 dias</option>
              <option value="all">Tudo</option>
            </select> : null}
            <div className="adminx-online-indicator" role="status" aria-label="Painel online"><i />Online</div>
            <button
              className="button adminx-client-mode-button"
              disabled={busy || !clientModeTarget}
              type="button"
              title={clientModeTarget ? `Entrar como ${clientModeTarget.email}` : "Selecione um cliente de teste no filtro"}
              onClick={() => void enterClientMode()}
            >
              <LogIn size={17} />
              Modo cliente
            </button>
            <div className="adminx-notification-center">
              <button
                aria-expanded={notificationCenterOpen}
                aria-label="Abrir notificações importantes"
                className="icon-button adminx-notification-button"
                type="button"
                title="Notificações importantes"
                onClick={() => setNotificationCenterOpen((current) => !current)}
              >
                <Bell size={19} />
                {importantNotifications.length ? <b>{importantNotifications.length}</b> : null}
              </button>
              {notificationCenterOpen ? (
                <section className="adminx-notification-popover">
                  <header>
                    <div><p>Central de alertas</p><strong>Importantes</strong></div>
                    <button className="icon-button" type="button" title="Fechar" onClick={() => setNotificationCenterOpen(false)}><X size={18} /></button>
                  </header>
                  <div className="adminx-notification-list">
                    {importantNotifications.map((notification) => (
                      <button key={notification.id} type="button" onClick={() => { setPage(notification.target); setNotificationCenterOpen(false); }}>
                        <strong>{notification.title}</strong>
                        <span>{notification.detail}</span>
                      </button>
                    ))}
                    {!importantNotifications.length ? <p className="adminx-notification-empty">Nenhuma pendência importante agora.</p> : null}
                  </div>
                  <button className="button primary" disabled={busy} type="button" onClick={enableNotifications}>
                    <Bell size={17} /> Ativar alertas no dispositivo
                  </button>
                </section>
              ) : null}
            </div>
            <button className="icon-button" type="button" title="Atualizar" onClick={refresh}><RefreshCw size={19} /></button>
          </div>
        </header>

        {error ? <div className="adminx-error"><AlertTriangle size={18} />{error}</div> : null}

        {page === "today" ? (
          <section className="adminx-page">
            <div className="adminx-metrics">
              <MetricCard Icon={History} tone="blue" title="Rotas reais hoje" value={todayValidationRoutes.length} detail={`${todayValidationRoutes.filter((route) => routeDecision(route) === "validated").length} validadas`} />
              <MetricCard Icon={ShieldCheck} tone="yellow" title="Para examinar" value={todayReviewRoutes.length} detail={`${todayValidationRoutes.filter(hasAnyReaction).length} com reação`} />
              <MetricCard Icon={Users} tone="green" title="Clientes online" value={onlineClients} detail={`${activeBots} monitorando`} />
              <MetricCard Icon={Inbox} tone="red" title="Suporte" value={support.unread} detail="não lidas" />
              <MetricCard Icon={Zap} tone={notAcceptableRoutes.length ? "red" : "green"} title="WhatsApp" value={notAcceptableRoutes.length} detail="not-acceptable" />
              <MetricCard Icon={Gauge} tone="blue" title="ACK P95" value={formatMs(p95FirstAck)} detail={`média ${formatMs(averageFirstAck)}`} />
            </div>
            <section className="adminx-dashboard-grid">
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>Sala de guerra</p><h2>Funil operacional de hoje</h2></div>
                  <StatusPill tone={todayReviewRoutes.length ? "yellow" : "green"}>{todayReviewRoutes.length ? "Ação necessária" : "Controle limpo"}</StatusPill>
                </div>
                <FunnelPanel steps={funnelSteps} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Clientes críticos</p><h2>Prioridade agora</h2></div>
                  <button className="button" type="button" onClick={() => setPage("clients")}>Abrir</button>
                </div>
                <ClientScoreList items={criticalClients} onOpen={openClient} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Agora</p><h2>Alertas inteligentes</h2></div>
                </div>
                <div className="adminx-alert-list">
                  {smartAlerts.map((alert) => (
                    <article className={`adminx-alert-row adminx-alert-${alert.tone}`} key={alert.id}>
                      <strong>{alert.title}</strong>
                      <span>{alert.detail}</span>
                    </article>
                  ))}
                  {!smartAlerts.length ? <p className="adminx-empty-text">Nenhum alerta importante agora.</p> : null}
                </div>
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>{REAL_VALIDATION_GROUP}</p><h2>Rotas para examinar</h2></div>
                  <button className="button" type="button" onClick={() => setPage("validations")}>Validar</button>
                </div>
                <RouteTable
                  routes={todayReviewRoutes.slice(0, 8)}
                  selectedRoutes={selectedRoutes}
                  compact
                  onSelect={toggleSelected}
                  onOpen={setRouteDetail}
                  onValidate={(id) => decideRoute(id, "validate")}
                  onReject={(id) => requestReject([id])}
                />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Erros recentes</p><h2>{logs.filter((log) => log.level === "error").length} erro(s)</h2></div>
                  <button className="button" type="button" onClick={() => setPage("logs")}>Logs</button>
                </div>
                <LogList logs={logs.filter((log) => log.level === "error").slice(0, 10)} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Suporte</p><h2>Mensagens não lidas</h2></div>
                  <button className="button" type="button" onClick={() => setPage("support")}>Abrir</button>
                </div>
                <SupportList messages={support.messages.filter((message) => !message.read).slice(0, 5)} onRead={readSupport} />
              </article>
            </section>
          </section>
        ) : null}

        {page === "operations" ? (
          <section className="adminx-page">
            <div className="adminx-metrics">
              <MetricCard Icon={Wifi} tone="green" title="Conectados" value={connectedBots} detail={`${onlineClients} painel(is) online`} />
              <MetricCard Icon={Bot} tone="blue" title="Armados" value={activeBots} detail="monitorando agora" />
              <MetricCard Icon={AlertTriangle} tone={liveClients.some((item) => item.needsAttention) ? "red" : "green"} title="Atenção" value={liveClients.filter((item) => item.needsAttention).length} detail="clientes para olhar" />
              <MetricCard Icon={Send} tone="yellow" title="Últimas 24h" value={todayRoutes.length} detail={`${todayValidationRoutes.length} motoristas`} />
            </div>

            <section className="adminx-ops-grid">
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>Operação ao vivo</p><h2>Clientes e bots agora</h2></div>
                  <button className="button" type="button" onClick={refresh}>Atualizar</button>
                </div>
                <div className="adminx-ops-client-grid">
                  {liveClients.map(({ client, latestRoute, recentErrors, stale, needsAttention }) => (
                    <button className={needsAttention ? "adminx-ops-client attention" : "adminx-ops-client"} key={client.email} type="button" onClick={() => openClient(client.email)} style={colorStyle(client.color)}>
                      <span className="adminx-client-dot" />
                      <div>
                        <strong>{client.email}</strong>
                        <small>{client.monitoringEnabled ? "Armado" : "Parado"} · {client.botStatus || "bot fechado"} · {client.presenceStatus}</small>
                        <em>{latestRoute ? `${latestRoute.groupName || latestRoute.groupJid} · ${latestRoute.confirmedCount}/${latestRoute.totalCount}` : "Sem disparos recentes"}</em>
                      </div>
                      <StatusPill tone={needsAttention ? "red" : client.monitoringEnabled ? "green" : "muted"}>
                        {client.blocked ? "Bloqueado" : stale ? "Ausente" : recentErrors.length ? "Erro" : client.monitoringEnabled ? "Ao vivo" : "Ok"}
                      </StatusPill>
                    </button>
                  ))}
                  {!liveClients.length ? <p className="adminx-empty-text">Nenhum cliente cadastrado.</p> : null}
                </div>
              </article>

              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Eventos recentes</p><h2>Últimos logs críticos</h2></div>
                  <button className="button" type="button" onClick={() => setPage("logs")}>Logs</button>
                </div>
                <LogList logs={logs.filter((log) => log.level === "error" || /not-acceptable|desconect|falh/i.test(log.message)).slice(0, 12)} />
              </article>

              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Fila quente</p><h2>O que decidir</h2></div>
                </div>
                <div className="adminx-alert-list">
                  {importantNotifications.map((item) => (
                    <button className="adminx-alert-row adminx-alert-yellow" key={`ops-${item.id}`} type="button" onClick={() => setPage(item.target)}>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                  {!importantNotifications.length ? <p className="adminx-empty-text">Sem pendência operacional agora.</p> : null}
                </div>
              </article>
            </section>
          </section>
        ) : null}

        {page === "dashboard" ? (
          <section className="adminx-page">
            <div className="adminx-metrics">
              <MetricCard Icon={Wifi} tone="green" title="Clientes online" value={onlineClients} detail={`${connectedBots} bots conectados`} />
              <MetricCard Icon={Bot} tone="blue" title="Monitoramentos" value={activeBots} detail="ativos agora" />
              <MetricCard Icon={ShieldCheck} tone="yellow" title="Para examinar" value={validationReviewRoutes.length} detail={`${pendingReactedImageRoutes.length} imagem(ns) reagida(s) em fila própria`} />
              <MetricCard Icon={Inbox} tone="red" title="Suporte" value={support.unread} detail="não lidas" />
              <MetricCard Icon={CheckCircle2} tone="green" title="Taxa validação" value={`${validationRate}%`} detail={`${validatedCount}/${visibleRoutes.length}`} />
              <MetricCard Icon={MessageSquareText} tone="yellow" title="Reações removidas" value={removedReactionRoutes.length} detail="auditáveis" />
              <MetricCard Icon={Gauge} tone="blue" title="Projeção mês" value={projectedMonthRoutes} detail="rotas estimadas" />
              <MetricCard Icon={Zap} tone={notAcceptableRoutes.length ? "red" : "green"} title="Gargalo WA" value={notAcceptableRoutes.length} detail={`ACK P95 ${formatMs(p95FirstAck)}`} />
            </div>

            <section className="adminx-dashboard-grid">
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>Inteligência</p><h2>Clientes mais saudáveis</h2></div>
                  <button className="button" type="button" onClick={() => setPage("reports")}>Relatório</button>
                </div>
                <ClientScoreList items={bestClients} onOpen={openClient} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Prioridade</p><h2>Fila de validação</h2></div>
                  <button className="button" type="button" onClick={() => setPage("validations")}>Abrir</button>
                </div>
                <RouteTable routes={validationReviewRoutes.slice(0, 6)} selectedRoutes={selectedRoutes} compact onSelect={toggleSelected} onOpen={setRouteDetail} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id])} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Rotas quentes</p><h2>Mais recorrentes</h2></div>
                </div>
                <div className="adminx-hot-routes">
                  {topRouteLabels.map((route, index) => (
                    <span key={`${route.label}-${index}`}><b>{route.count}x</b>{route.label}</span>
                  ))}
                  {!topRouteLabels.length ? <p className="adminx-empty-text">Sem rotas no filtro.</p> : null}
                </div>
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Disparos por hora</p><h2>{visibleRoutes.length} no período</h2></div>
                </div>
                <div className="adminx-bars">
                  {hourlyChart.map((slot) => (
                    <span key={slot.hour} style={{ height: `${slot.height}%` }} title={`${slot.hour}h: ${slot.count}`} />
                  ))}
                </div>
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Tempo real</p><h2>Últimos logs</h2></div>
                  <button className="button" type="button" onClick={() => setPage("logs")}>Ver logs</button>
                </div>
                <LogList logs={visibleLogs.slice(0, 10)} />
              </article>
              <article className="adminx-panel">
                <div className="adminx-panel-head">
                  <div><p>Motor visual</p><h2>{ocrRoutes.length} disparos por imagem</h2></div>
                  <button className="button" type="button" onClick={() => { setModeFilter("ocr"); setPage("history"); }}>Auditar</button>
                </div>
                <div className="adminx-ocr-list">
                  {ocrRoutes.slice(0, 8).map((route) => (
                    <button key={`ocr-${route.id}`} type="button" onClick={() => setRouteDetail(route)}>
                      <strong>{route.ocr?.route || route.ocr?.bairro || route.messages[0]}</strong>
                      <small>{route.clientEmail} - {route.ocr?.source}</small>
                    </button>
                  ))}
                  {!ocrRoutes.length ? <p className="adminx-empty-text">Nenhuma análise visual no filtro atual.</p> : null}
                </div>
              </article>
            </section>
          </section>
        ) : null}

        {page === "clients" ? (
          <section className="adminx-page">
            <div className="adminx-page-actions">
              <button className="button primary" type="button" onClick={() => setEditor(emptyEditor)}><UserPlus size={18} />Adicionar usuário</button>
              <button className="button" type="button" onClick={() => exportRoutes("csv")}><Download size={18} />Exportar rotas</button>
            </div>
            {editor ? <UserEditor value={editor} busy={busy} competitors={safeAdminUsers} onChange={setEditor} onCancel={() => setEditor(undefined)} onSave={() => saveUser()} /> : null}
            <ClientsTable users={safeAdminUsers} onOpen={openClient} onEdit={(user) => setEditor({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400, dispatchMatchups: user.dispatchMatchups || [] })} onToggleBlock={(user) => saveUser({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: !user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400, dispatchMatchups: user.dispatchMatchups || [] })} />
          </section>
        ) : null}

        {page === "validations" ? (
          <section className="adminx-page">
            <RouteFilters decisionFilter={decisionFilter} modeFilter={modeFilter} onDecision={setDecisionFilter} onMode={setModeFilter} />
            <div className="adminx-metrics">
              <MetricCard Icon={ShieldCheck} tone="yellow" title="Para examinar" value={validationReviewRoutes.length} detail={REAL_VALIDATION_GROUP} />
              <MetricCard Icon={Clock3} tone="yellow" title="Pendentes reais" value={validationPendingRoutes.length} detail="aguardando decisão" />
            </div>
            <div className="adminx-page-actions">
              <StatusPill tone="yellow">{selectedRoutes.length} selecionada(s)</StatusPill>
              <button className="button primary" disabled={!selectedRoutes.length || busy} type="button" onClick={() => decideSelected("validate")}>Validar lote</button>
              <button className="button danger" disabled={!selectedRoutes.length || busy} type="button" onClick={() => decideSelected("reject")}>Rejeitar lote</button>
            </div>
            <section className="adminx-validation-grid">
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>{REAL_VALIDATION_GROUP}</p><h2>Fila real para examinar</h2></div>
                  <StatusPill tone="yellow">{validationReviewRoutes.length} rota(s)</StatusPill>
                </div>
                <RouteTable routes={validationReviewRoutes} selectedRoutes={selectedRoutes} onSelect={toggleSelected} onOpen={setRouteDetail} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id])} />
              </article>
            </section>
          </section>
        ) : null}

        {page === "reactions" ? (
          <section className="adminx-page">
            <div className="adminx-metrics">
              <MetricCard Icon={MessageSquareText} tone="yellow" title="Para decidir" value={pendingReactedImageRoutes.length} detail="somente imagens reagidas" />
              <MetricCard Icon={CheckCircle2} tone="green" title="Já decididas" value={decidedReactedImageRoutes.length} detail="histórico manual" />
              <MetricCard Icon={BrainCircuit} tone="blue" title="Total reagidas" value={reactedImageRoutes.length} detail="análises de imagem" />
            </div>
            <div className="adminx-page-actions">
              <StatusPill tone="yellow">{selectedRoutes.filter((id) => pendingReactedImageRoutes.some((route) => route.id === id)).length} pendente(s) selecionada(s)</StatusPill>
              <button className="button primary" disabled={!selectedRoutes.some((id) => pendingReactedImageRoutes.some((route) => route.id === id)) || busy} type="button" onClick={() => decideSelected("validate")}>Validar selecionadas</button>
              <button className="button danger" disabled={!selectedRoutes.some((id) => pendingReactedImageRoutes.some((route) => route.id === id)) || busy} type="button" onClick={() => decideSelected("reject")}>Rejeitar selecionadas</button>
              <button className="button danger" disabled={!pendingReactedImageRoutes.length || busy} type="button" onClick={() => requestReject(pendingReactedImageRoutes.map((route) => route.id), "Rejeitar todas as análises pendentes")}>Rejeitar todas</button>
            </div>
            <section className="adminx-validation-grid">
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>Decisão exclusivamente manual</p><h2>Análises de imagem que receberam reação</h2></div>
                  <StatusPill tone={pendingReactedImageRoutes.length ? "yellow" : "green"}>{pendingReactedImageRoutes.length ? `${pendingReactedImageRoutes.length} pendente(s)` : "Fila limpa"}</StatusPill>
                </div>
                <div className="adminx-analysis-list">
                  {pendingReactedImageRoutes.map((route) => {
                    const usageEntry = imageUsage.entries.find((entry) => entry.id === route.ocr?.analysisId || entry.routeDispatchId === route.id);
                    return (
                      <article className="adminx-analysis-row status-pending" key={`reaction-price-${route.id}`}>
                        <div className="adminx-analysis-signal"><CircleDollarSign size={20} /></div>
                        <div className="adminx-analysis-copy">
                          <strong>{route.ocr?.route || route.ocr?.bairro || route.messages[0] || "Análise reagida"}</strong>
                          <small>{route.clientEmail} · {route.ocr?.code || "sem gaiola"} · {formatShort(route.createdAt)}</small>
                        </div>
                        <label className="adminx-analysis-value">
                          <span>R$</span>
                          <input
                            disabled={!usageEntry || busy}
                            inputMode="decimal"
                            value={usageEntry ? usageAmounts[usageEntry.id] || "0,00" : "0,00"}
                            onChange={(event) => usageEntry && editUsageAmount(usageEntry.id, event.target.value)}
                          />
                        </label>
                        <div className="adminx-analysis-actions">
                          <button className="button primary" disabled={!usageEntry || busy} type="button" onClick={() => usageEntry && updateImageUsage(usageEntry.id, "billable")}>Validar com valor</button>
                          <button className="button danger" disabled={busy} type="button" onClick={() => requestReject([route.id], "Rejeitar análise reagida")}>Rejeitar</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <RouteTable routes={reactedImageRoutes} selectedRoutes={selectedRoutes} onSelect={toggleSelected} onOpen={setRouteDetail} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id], "Rejeitar análise reagida")} />
                {!reactedImageRoutes.length ? <p className="adminx-empty-text">Nenhuma análise de imagem reagida neste período.</p> : null}
              </article>
            </section>
          </section>
        ) : null}

        {page === "validated_ai" ? (
          <section className="adminx-page">
            <RouteFilters decisionFilter={decisionFilter} modeFilter={modeFilter} onDecision={setDecisionFilter} onMode={setModeFilter} />
            <div className="adminx-metrics">
              <MetricCard Icon={CheckCircle2} tone="green" title="Rotas IA válidas" value={validatedImageRoutes.length} detail="confirmadas automaticamente pelo líder" />
              <MetricCard Icon={CircleDollarSign} tone="green" title="Consumo validado" value={formatMoney(imageUsage.totals.amountCents)} detail="incluído no consumo da IA" />
            </div>
            <article className="adminx-panel adminx-panel-wide">
              <div className="adminx-panel-head">
                <div><p>Histórico automático</p><h2>Rotas de imagem confirmadas com 👍 do líder</h2></div>
                <StatusPill tone="green">{validatedImageRoutes.length} válida(s)</StatusPill>
              </div>
              <RouteTable routes={validatedImageRoutes} selectedRoutes={[]} readOnly onSelect={() => undefined} onOpen={setRouteDetail} onValidate={() => undefined} onReject={() => undefined} />
            </article>
          </section>
        ) : null}

        {page === "validated_routes" ? (
          <section className="adminx-page">
            <RouteFilters decisionFilter={decisionFilter} modeFilter={modeFilter} onDecision={setDecisionFilter} onMode={setModeFilter} />
            <div className="adminx-metrics">
              <MetricCard Icon={ShieldCheck} tone="green" title="Rotas validadas" value={allValidatedRoutes.length} detail="IA, Target e confirmação manual" />
              <MetricCard Icon={CircleDollarSign} tone="green" title="Saldo em aberto" value={formatMoney(imageUsage.totals.amountCents)} detail={`${imageUsage.totals.unpaidRoutes} rota(s) não pagas`} />
            </div>
            <article className="adminx-panel adminx-panel-wide">
              <div className="adminx-panel-head"><div><p>Histórico completo</p><h2>Todas as rotas confirmadas</h2></div><StatusPill tone="green">{allValidatedRoutes.length} validadas</StatusPill></div>
              <RouteTable routes={allValidatedRoutes} selectedRoutes={[]} readOnly onSelect={() => undefined} onOpen={setRouteDetail} onValidate={() => undefined} onReject={() => undefined} />
              {!allValidatedRoutes.length ? <p className="adminx-empty-text">Ainda não há rotas validadas neste filtro.</p> : null}
            </article>
          </section>
        ) : null}

        {page === "costs" ? (
          <section className="adminx-page adminx-costs-page">
            <div className="adminx-metrics">
              <MetricCard Icon={CircleDollarSign} tone="yellow" title="Total a receber" value={formatMoney(imageUsage.totals.amountCents)} detail="somente saldo em aberto" />
              <MetricCard Icon={Route} tone="blue" title="Rotas em aberto" value={imageUsage.totals.unpaidRoutes} detail="Target, manual e IA" />
              <MetricCard Icon={CheckCircle2} tone="green" title="Rotas validadas" value={validatedCount} detail="histórico geral" />
            </div>
            <article className="adminx-panel adminx-panel-wide">
              <div className="adminx-panel-head"><div><p>Financeiro por cliente</p><h2>Preço e ciclo de cobrança</h2></div><CircleDollarSign size={22} /></div>
              <p className="adminx-costs-note">Toda rota validada é contabilizada. Créditos pré-pagos são consumidos primeiro; depois, o valor configurado por rota entra no saldo até o pagamento.</p>
              <div className="adminx-costs-list">
                {pricingClients.map((client) => (
                  <section className="adminx-cost-client" key={client.clientEmail}>
                    <header><div><strong>{client.clientEmail}</strong><small>{client.unpaidRoutes} rota(s) em aberto · vence todo dia {client.dueDay}</small></div><strong className="adminx-cost-balance">{formatMoney(client.amountCents)}</strong></header>
                    <div className="adminx-cost-controls">
                      <label><span>Valor por rota</span><input inputMode="decimal" value={usageAmounts[`client:${client.clientEmail}`] ?? (client.routePriceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} onChange={(event) => editUsageAmount(`client:${client.clientEmail}`, event.target.value)} /></label>
                      <button className="button primary" disabled={busy} type="button" onClick={() => saveFinanceSettings(client.clientEmail, "price")}>Salvar preço</button>
                      <label><span>Dia de vencimento (1–31)</span><input inputMode="numeric" value={dueDayDrafts[client.clientEmail] ?? String(client.dueDay)} onChange={(event) => setDueDayDrafts((draft) => ({ ...draft, [client.clientEmail]: event.target.value }))} /></label>
                      <button className="button" disabled={busy} type="button" onClick={() => saveFinanceSettings(client.clientEmail, "due")}>Salvar data</button>
                      <label><span>Cobrar a cada N rotas (0 = por data)</span><input inputMode="numeric" min="0" value={routeCadenceDrafts[client.clientEmail] ?? String(client.paymentEveryRoutes)} onChange={(event) => setRouteCadenceDrafts((draft) => ({ ...draft, [client.clientEmail]: event.target.value }))} /></label>
                      <button className="button" disabled={busy} type="button" onClick={() => saveFinanceSettings(client.clientEmail, "cadence")}>Salvar ciclo</button>
                      <label><span>Rotas antecipadas pagas (quantidade exata)</span><input inputMode="numeric" min="0" placeholder="0" value={prepaidDrafts[client.clientEmail] ?? String(client.prepaidRoutesRemaining)} onChange={(event) => setPrepaidDrafts((draft) => ({ ...draft, [client.clientEmail]: event.target.value }))} /></label>
                      <button className="button" disabled={busy || prepaidDrafts[client.clientEmail] === ""} type="button" onClick={() => saveFinanceSettings(client.clientEmail, "credits")}>Salvar quantidade</button>
                      <button className="button danger" disabled={busy || client.prepaidRoutesRemaining === 0} type="button" onClick={() => clearPrepaidRoutes(client.clientEmail)}>Zerar saldo</button>
                    </div>
                    <footer><span>{client.prepaidRoutesRemaining} rota(s) pré-paga(s) restante(s)</span><button className="button" disabled={busy || client.amountCents <= 0} type="button" onClick={() => markClientPaid(client.clientEmail)}>Registrar pagamento e iniciar novo período</button></footer>
                  </section>
                ))}
                {!pricingClients.length ? <p className="adminx-empty-text">Nenhum cliente cadastrado.</p> : null}
              </div>
            </article>
            <article className="adminx-panel adminx-panel-wide">
              <div className="adminx-panel-head"><div><p>Livro financeiro</p><h2>Rotas e cobranças</h2></div><StatusPill tone="blue">{(imageUsage.ledgerEntries || imageUsage.entries).length} registro(s)</StatusPill></div>
              <div className="adminx-cost-ledger">
                {(imageUsage.ledgerEntries || imageUsage.entries).filter((entry) => entry.decision === "billable" && (clientFilter === "all" || entry.clientEmail === clientFilter)).map((entry) => (
                  <div key={entry.id}><span><strong>{entry.clientEmail}</strong><small>{entry.gaiola || entry.route || entry.bairro || "Rota validada"} · {formatShort(entry.reviewedAt || entry.createdAt)} · {entry.billingSource || "imagem"}</small></span><span>{entry.paymentStatus === "prepaid" ? "Pré-paga" : entry.paymentStatus === "paid" ? "Pago" : "Em aberto"}</span><strong>{formatMoney(entry.amountCents)}</strong></div>
                ))}
                {!(imageUsage.ledgerEntries || imageUsage.entries).some((entry) => entry.decision === "billable" && (clientFilter === "all" || entry.clientEmail === clientFilter)) ? <p className="adminx-empty-text">Nenhuma rota no livro financeiro.</p> : null}
              </div>
            </article>
          </section>
        ) : null}

        {page === "usage" ? (
          <section className="adminx-page adminx-usage-page">
            <div className="adminx-metrics">
              <MetricCard Icon={BrainCircuit} tone="blue" title="Análises do mês" value={imageUsage.totals.total} detail={`${imageUsage.totals.detected} com leitura segura`} />
              <MetricCard Icon={Clock3} tone="yellow" title="Para revisar" value={imageUsage.totals.pending} detail="aguardando sua decisão" />
              <MetricCard Icon={CheckCircle2} tone="green" title="Aprovadas" value={imageUsage.totals.billable} detail="incluídas no consumo" />
              <MetricCard Icon={CircleDollarSign} tone="green" title="Consumo aprovado" value={formatMoney(imageUsage.totals.amountCents)} detail={imageUsage.month.split("-").reverse().join("/")} />
            </div>

            <section className="adminx-usage-layout">
              <article className="adminx-panel adminx-pricing-panel">
                <div className="adminx-panel-head">
                  <div><p>Valores por cliente</p><h2>Preço e total mensal</h2></div>
                  <CircleDollarSign size={22} />
                </div>
                <div className="adminx-pricing-list">
                  {pricingClients.map((client) => (
                    <div className="adminx-pricing-row" key={client.clientEmail}>
                      <button
                        aria-pressed={client.billAllValidatedRoutes}
                        className={`button adminx-route-billing-toggle ${client.billAllValidatedRoutes ? "is-on" : ""}`}
                        disabled={busy}
                        type="button"
                        onClick={() => updateRouteBillingMode(client.clientEmail, !client.billAllValidatedRoutes)}
                      >
                        {client.billAllValidatedRoutes ? "Todas as rotas: cobrando" : "Somente IA: cobrar todas as rotas"}
                      </button>
                      <div><strong>{client.clientEmail}</strong><small>{client.billable} aprovada(s) · total atual {formatMoney(client.amountCents)}</small></div>
                      <label><span>Preço R$</span><input inputMode="decimal" value={usageAmounts[`client:${client.clientEmail}`] || "0,00"} onChange={(event) => editUsageAmount(`client:${client.clientEmail}`, event.target.value)} /></label>
                      <button className="button" disabled={busy} type="button" onClick={() => updateImagePricing(client.clientEmail)}>Preço padrão</button>
                      <label><span>Total R$</span><input inputMode="decimal" value={usageAmounts[`total:${client.clientEmail}`] || "0,00"} onChange={(event) => editUsageAmount(`total:${client.clientEmail}`, event.target.value)} /></label>
                      <button className="button primary" disabled={busy} type="button" onClick={() => updateImageMonthlyTotal(client.clientEmail)}>Salvar total</button>
                    </div>
                  ))}
                  {!pricingClients.length ? <p className="adminx-empty-text">Nenhum cliente cadastrado.</p> : null}
                </div>
              </article>

              <article className="adminx-panel adminx-panel-wide adminx-analysis-panel">
                <div className="adminx-panel-head">
                  <div><p>Análise inteligente</p><h2>Revisão de consumo</h2></div>
                  <StatusPill tone={imageUsage.totals.pending ? "yellow" : "green"}>{imageUsage.totals.pending ? `${imageUsage.totals.pending} pendente(s)` : "Tudo revisado"}</StatusPill>
                </div>
                <div className="adminx-usage-tabs" role="tablist" aria-label="Exibição das análises">
                  <button className={usageView === "pending" ? "active" : ""} role="tab" aria-selected={usageView === "pending"} type="button" onClick={() => setUsageView("pending")}>Pendências ({imageUsage.totals.pending})</button>
                  <button className={usageView === "history" ? "active" : ""} role="tab" aria-selected={usageView === "history"} type="button" onClick={() => setUsageView("history")}>Histórico completo</button>
                </div>
                <div className="adminx-analysis-list">
                  {visibleUsageEntries.map((entry) => {
                    const linkedRoute = routeByAnalysisId.get(entry.id) || routes.routes.find((route) => route.id === entry.routeDispatchId);
                    const waitUntilDispatchMs = linkedRoute && entry.analysisFinishedAt
                      ? Math.max(0, new Date(linkedRoute.createdAt).getTime() - new Date(entry.analysisFinishedAt).getTime())
                      : undefined;
                    return <article className={`adminx-analysis-row status-${entry.decision}`} key={entry.id}>
                      <div className="adminx-analysis-signal"><BrainCircuit size={20} /><span>{entry.confidence === undefined ? "--" : `${entry.confidence}%`}</span></div>
                      <div className="adminx-analysis-copy">
                        <strong>{entry.route || entry.bairro || (entry.result === "unreadable" ? "Imagem sem leitura segura" : "Falha na análise")}</strong>
                        <small>{entry.clientEmail} · {entry.gaiola || "gaiola não confirmada"} · {formatShort(entry.createdAt)}</small>
                        <span className="adminx-analysis-group">{entry.groupName || linkedRoute?.groupName || entry.groupJid || linkedRoute?.groupJid || "Grupo não registrado"}</span>
                        <div className="adminx-analysis-times">
                          <span><b>{formatMs(entry.analysisDurationMs)}</b> análise</span>
                          <span><b>{formatMs(waitUntilDispatchMs)}</b> até envio</span>
                          <span><b>{formatMs(linkedRoute?.dispatchTimeline?.totalDurationMs)}</b> disparo</span>
                          <span><b>{linkedRoute ? triggerLabel(linkedRoute) : "Imagem recebida"}</b> origem</span>
                        </div>
                      </div>
                      <StatusPill tone={entry.decision === "billable" ? "green" : entry.decision === "excluded" ? "muted" : "yellow"}>
                        {entry.decision === "billable" ? "Aprovada" : entry.decision === "excluded" ? "Excluída" : "Pendente"}
                      </StatusPill>
                      <label className="adminx-analysis-value"><span>R$</span><input inputMode="decimal" value={usageAmounts[entry.id] || "0,00"} onChange={(event) => editUsageAmount(entry.id, event.target.value)} /></label>
                      <div className="adminx-analysis-actions">
                        <button className="icon-button success" disabled={busy} type="button" title="Validar imagem, rota e cobrança" onClick={() => updateImageUsage(entry.id, "billable")}><CheckCircle2 size={18} /></button>
                        <button className="icon-button danger" disabled={busy} type="button" title="Excluir imagem e rota da pendência" onClick={() => updateImageUsage(entry.id, "excluded")}><Ban size={18} /></button>
                        {entry.decision !== "pending" ? <button className="icon-button" disabled={busy} type="button" title="Reabrir revisão" onClick={() => updateImageUsage(entry.id, "pending")}><RotateCcw size={18} /></button> : null}
                      </div>
                    </article>;
                  })}
                  {!visibleUsageEntries.length ? <p className="adminx-empty-text">{usageView === "pending" ? "Nenhuma análise pendente. Tudo resolvido." : "Nenhuma análise neste filtro."}</p> : null}
                </div>
              </article>
            </section>
          </section>
        ) : null}

        {page === "history" ? (
          <section className="adminx-page">
            <RouteFilters decisionFilter={decisionFilter} modeFilter={modeFilter} onDecision={setDecisionFilter} onMode={setModeFilter} />
            <div className="adminx-metrics">
              <MetricCard Icon={ShieldCheck} tone="yellow" title="Motoristas" value={realValidationRoutes.length} detail="disparos importantes" />
              <MetricCard Icon={History} tone="blue" title="Outros grupos" value={otherHistoryRoutes.length} detail="também visíveis" />
              <MetricCard Icon={Send} tone="green" title="Total" value={visibleRoutes.length} detail="todos os disparos" />
            </div>
            <div className="adminx-page-actions">
              <button className="button" type="button" onClick={() => exportRoutes("csv")}><Download size={18} />CSV</button>
              <button className="button" type="button" onClick={() => exportRoutes("json")}><FileJson size={18} />JSON</button>
            </div>
            <section className="adminx-history-split">
              <article className="adminx-panel adminx-panel-wide adminx-important-panel">
                <div className="adminx-panel-head">
                  <div><p>{REAL_VALIDATION_GROUP}</p><h2>Disparos importantes</h2></div>
                  <StatusPill tone="yellow">{realValidationRoutes.length} registro(s)</StatusPill>
                </div>
                <RouteTable routes={realValidationRoutes} selectedRoutes={selectedRoutes} onSelect={toggleSelected} onOpen={setRouteDetail} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id])} />
              </article>
              <article className="adminx-panel adminx-panel-wide">
                <div className="adminx-panel-head">
                  <div><p>Demais grupos</p><h2>Todos os outros disparos</h2></div>
                  <StatusPill tone="blue">{otherHistoryRoutes.length} registro(s)</StatusPill>
                </div>
                <RouteTable routes={otherHistoryRoutes} selectedRoutes={selectedRoutes} onSelect={toggleSelected} onOpen={setRouteDetail} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id])} />
              </article>
            </section>
          </section>
        ) : null}

        {page === "logs" ? (
          <section className="adminx-page">
            <div className="adminx-page-actions">
              <select value={logLevel} onChange={(event) => setLogLevel(event.target.value as LogLevelFilter)}>
                <option value="all">Todos os níveis</option>
                <option value="success">Sucesso</option>
                <option value="info">Info</option>
                <option value="warning">Aviso</option>
                <option value="error">Erro</option>
              </select>
              <button className="button danger" type="button" onClick={() => cleanup("logs")}><Trash2 size={18} />{cleanupTarget === "logs" ? "Confirmar limpar logs" : "Limpar logs"}</button>
            </div>
            <LogList logs={visibleLogs} full />
          </section>
        ) : null}

        {page === "support" ? (
          <section className="adminx-page">
            <SupportList messages={visibleSupport} onRead={readSupport} />
          </section>
        ) : null}

        {page === "reports" ? (
          <section className="adminx-page">
            <article className="adminx-panel adminx-report-filter">
              <div className="adminx-panel-head">
                <div><p>Período do relatório</p><h2>Filtrar por data</h2></div>
                <span className="adminx-date-result">{reportRoutes.length} rota(s) encontrada(s)</span>
              </div>
              <div className="adminx-report-presets" role="group" aria-label="Período do relatório">
                <button className={reportDatePreset === "current-month" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("current-month")}>Este mês</button>
                <button className={reportDatePreset === "previous-month" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("previous-month")}>Mês passado</button>
                <button className={reportDatePreset === "last-30-days" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("last-30-days")}>Últimos 30 dias</button>
                <button className={reportDatePreset === "all" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("all")}>Tudo</button>
              </div>
              <div className="adminx-report-calendar">
                <label><span>Data inicial</span><input type="date" value={reportStartDate} onChange={(event) => { setReportDatePreset("custom"); setReportStartDate(event.target.value); }} /></label>
                <label><span>Data final</span><input type="date" value={reportEndDate} onChange={(event) => { setReportDatePreset("custom"); setReportEndDate(event.target.value); }} /></label>
              </div>
            </article>
            <div className="adminx-metrics">
              <MetricCard Icon={History} tone="blue" title="Rotas" value={reportRoutes.length} detail="no período" />
              <MetricCard Icon={CheckCircle2} tone="green" title="Validadas" value={reportValidatedCount} detail={`${reportValidationRate}%`} />
              <MetricCard Icon={Ban} tone="red" title="Rejeitadas" value={reportRoutes.filter((route) => routeDecision(route) === "rejected").length} detail="julgadas" />
              <MetricCard Icon={MessageSquareText} tone="yellow" title="Líder" value={reportRoutes.filter(hasLeaderReaction).length} detail="com reação" />
            </div>
            <article className="adminx-panel">
              <div className="adminx-panel-head">
                <div><p>Por cliente</p><h2>Relatório operacional</h2></div>
                <button className="button" type="button" onClick={() => exportRoutes("csv", reportRoutes)}>Exportar CSV</button>
              </div>
              <ReportTable clients={clients} routes={reportRoutes} />
            </article>
          </section>
        ) : null}

        {page === "maintenance" ? (
          <section className="adminx-page">
            <article className="adminx-panel">
              <div className="adminx-panel-head">
                <div><p>Escopo</p><h2>{clientFilter === "all" ? "Todos os clientes" : clientFilter}</h2></div>
              </div>
              <div className="adminx-maintenance-grid">
                {[
                  ["logs", "Limpar logs", "Apaga eventos salvos do bot"],
                  ["routes", "Limpar histórico", "Apaga disparos/validações"],
                  ["support", "Limpar suporte", "Apaga mensagens internas"],
                  ["all", "Limpar tudo", "Logs, rotas e suporte"]
                ].map(([target, title, detail]) => (
                  <button className={cleanupTarget === target ? "adminx-danger-card confirm" : "adminx-danger-card"} disabled={busy} key={target} type="button" onClick={() => cleanup(target as CleanupTarget)}>
                    <Trash2 size={20} />
                    <strong>{cleanupTarget === target ? `Confirmar ${title}` : title}</strong>
                    <span>{detail}</span>
                  </button>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {page === "settings" ? (
          <section className="adminx-page">
            <article className="adminx-panel">
              <div className="adminx-panel-head">
                <div><p>Admin</p><h2>Configurações e sessão</h2></div>
              </div>
              <div className="adminx-settings-grid">
                <section className="adminx-settings-card">
                  <ShieldCheck size={20} />
                  <strong>Backup externo</strong>
                  <span>
                    {!cloudBackupStatus ? "Consultando status do backup..." : !cloudBackupStatus.configured
                      ? "Configure as variáveis do R2 e a chave de criptografia no Render."
                      : cloudBackupStatus.running
                        ? "Enviando snapshot criptografado para o R2..."
                        : cloudBackupStatus.lastSuccessAt
                          ? `Último envio concluído em ${formatDate(cloudBackupStatus.lastSuccessAt)}. Retenção: ${cloudBackupStatus.retentionDays} dias.`
                          : "Backup configurado; aguardando o primeiro envio automático."}
                    {cloudBackupStatus?.lastError ? " O último envio falhou; confira os logs do serviço." : ""}
                  </span>
                  <button className="button primary" disabled={!cloudBackupStatus?.configured || cloudBackupBusy || cloudBackupStatus.running} type="button" onClick={() => void createCloudBackupNow()}>
                    {cloudBackupBusy || cloudBackupStatus?.running ? "Backup em andamento..." : "Criar backup agora"}
                  </button>
                  <label className="adminx-backup-picker">
                    <span>Selecione manualmente o backup da data anterior à migração. O tamanho não garante que o snapshot tenha os dados corretos.</span>
                    <select value={selectedCloudBackupKey} onChange={(event) => setSelectedCloudBackupKey(event.target.value)} disabled={!cloudBackupObjects.length || cloudRestoreBusy}>
                      <option value="">Selecione o snapshot pela data</option>
                      {cloudBackupObjects.map((item) => {
                        return <option key={item.key} value={item.key}>{item.key} · {formatBackupSize(item.size)} · {formatDate(item.lastModified)}</option>;
                      })}
                    </select>
                  </label>
                  {cloudBackupListError ? <span className="adminx-backup-error">{cloudBackupListError}</span> : null}
                  {!cloudBackupListError && !cloudBackupObjects.length ? <span>Nenhum arquivo de backup encontrado no R2.</span> : null}
                  <section className={`adminx-restore-progress phase-${cloudRestoreStatus?.phase || "idle"}`} aria-live="polite">
                    <strong>Restauração: {cloudRestoreStatus ? restorePhaseLabels[cloudRestoreStatus.phase] : "Consultando"}</strong>
                    <span>{cloudRestoreStatus?.message || "Consultando o andamento..."}</span>
                    {cloudRestoreStatus?.sourceKey ? <small>Arquivo: {cloudRestoreStatus.sourceKey}</small> : null}
                    {cloudRestoreStatus?.progress !== undefined && !["completed", "failed"].includes(cloudRestoreStatus.phase)
                      ? <progress max={100} value={cloudRestoreStatus.progress * (100 / 95)} />
                      : null}
                    {cloudRestoreStatus?.completedAt ? <small>Concluída em {formatDate(cloudRestoreStatus.completedAt)}</small> : null}
                  </section>
                  <span>Durante a restauração, o serviço reinicia. Os dados que já estavam nele são preservados.</span>
                  <button className="button" disabled={!cloudBackupStatus?.configured || !selectedCloudBackupKey || cloudRestoreBusy || ["listing", "waiting_backup", "downloading", "validating", "ready", "applying"].includes(cloudRestoreStatus?.phase || "")} type="button" onClick={() => void restoreCloudBackupNow()}>
                    {cloudRestoreBusy || ["listing", "waiting_backup", "downloading", "validating", "ready", "applying"].includes(cloudRestoreStatus?.phase || "") ? "Restauração em andamento..." : "Restaurar snapshot selecionado"}
                  </button>
                </section>
                <section className="adminx-settings-card">
                  <FileJson size={20} />
                  <strong>Arquivo portátil (iPhone / outro site)</strong>
                  <span>Exporte os dados para um arquivo criptografado. No site novo, escolha esse arquivo e confira o resumo antes de importar.</span>
                  <label>
                    <span>Senha do arquivo — guarde-a em outro lugar. Sem ela, não dá para abrir o backup.</span>
                    <input
                      autoComplete="new-password"
                      type="password"
                      value={portableBackupPassphrase}
                      onChange={(event) => {
                        setPortableBackupPassphrase(event.target.value);
                        setPortableBackupPreview(undefined);
                      }}
                      placeholder="Pelo menos 12 caracteres"
                    />
                  </label>
                  <button className="button primary" disabled={portableBackupBusy || portableBackupPassphrase.length < 12} type="button" onClick={() => void exportPortableBackupNow()}>
                    <Download size={16} /> {portableBackupBusy ? "Preparando arquivo..." : "Exportar para Arquivos"}
                  </button>
                  <label>
                    <span>No site novo, selecione o arquivo .botbackup:</span>
                    <input
                      accept=".botbackup,application/vnd.rota-mind.portable-backup,application/octet-stream"
                      type="file"
                      onChange={(event) => {
                        setPortableBackupFile(event.target.files?.[0]);
                        setPortableBackupPreview(undefined);
                      }}
                    />
                  </label>
                  {portableBackupFile ? <small>Arquivo selecionado: {portableBackupFile.name} · {formatBackupSize(portableBackupFile.size)}</small> : null}
                  <button className="button" disabled={portableBackupBusy || !portableBackupFile || portableBackupPassphrase.length < 12} type="button" onClick={() => void previewPortableBackupNow()}>
                    <Upload size={16} /> {portableBackupBusy ? "Enviando e conferindo..." : "Conferir arquivo"}
                  </button>
                  {portableBackupPreview ? (
                    <section className="adminx-restore-progress phase-ready" aria-live="polite">
                      <strong>Arquivo válido — confira antes de importar</strong>
                      <span>{portableBackupPreview.summary.clients} cliente(s) · {portableBackupPreview.summary.routes} rota(s) · {portableBackupPreview.summary.validatedRoutes} validada(s) · {portableBackupPreview.summary.files} arquivo(s)</span>
                      <span>O site atual só será substituído quando você tocar em “Importar agora”.</span>
                      <button className="button primary" disabled={portableBackupBusy} type="button" onClick={() => void applyPortableBackupNow()}>
                        {portableBackupBusy ? "Aplicando..." : "Importar agora"}
                      </button>
                    </section>
                  ) : null}
                </section>
                <section className="adminx-settings-card">
                  <Bell size={20} />
                  <strong>Notificações</strong>
                  <span>Receba alertas críticos mesmo quando a aba do painel estiver fechada.</span>
                  <button className="button primary" disabled={busy} type="button" onClick={enableNotifications}>Ativar notificações</button>
                </section>
                <section className="adminx-settings-card">
                  <RefreshCw size={20} />
                  <strong>Filtros do painel</strong>
                  <span>Cliente, período, busca, modo e status voltam ao padrão.</span>
                  <button className="button" type="button" onClick={resetAdminFilters}>Resetar filtros</button>
                </section>
                <section className="adminx-settings-card">
                  <Activity size={20} />
                  <strong>Status do tempo real</strong>
                  <span>O painel está online e sincronizando as atualizações.</span>
                  <button className="button" type="button" onClick={refresh}>Atualizar agora</button>
                </section>
                <section className="adminx-settings-card danger">
                  <LogOut size={20} />
                  <strong>Sair da conta admin</strong>
                  <span>Encerra a sessão salva neste navegador.</span>
                  <button className="button danger" type="button" onClick={onLogout}>Sair da conta</button>
                </section>
              </div>
              <section className="adminx-leader-manager">
                <div className="adminx-panel-head">
                  <div>
                    <p>Líderes de reação</p>
                    <h2>{leaders.length} líder(es) configurado(s)</h2>
                  </div>
                </div>
                <form className="adminx-leader-form" onSubmit={saveLeader}>
                  <input
                    value={leaderDraft.name}
                    onChange={(event) => setLeaderDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Nome do líder"
                  />
                  <input
                    value={leaderDraft.phone}
                    onChange={(event) => setLeaderDraft((current) => ({ ...current, phone: event.target.value }))}
                    placeholder="Telefone com DDI. Ex.: 5521999999999"
                  />
                  <button className="button primary" disabled={busy || !leaderDraft.name.trim() || !leaderDraft.phone.trim()} type="submit">
                    Adicionar líder
                  </button>
                </form>
                <div className="adminx-leader-candidates">
                  <div className="adminx-section-title">
                    <strong>Candidatos detectados</strong>
                    <span>Telefones que reagiram em rotas e ainda não estão salvos como líderes.</span>
                  </div>
                  {leaderCandidates.map((candidate) => (
                    <article key={candidate.phone}>
                      <div>
                        <strong>{candidate.name}</strong>
                        <span>{candidate.phone} · {candidate.count} reação(ões) · {formatShort(candidate.lastAt)}</span>
                      </div>
                      <button className="button primary" disabled={busy} type="button" onClick={() => saveLeaderContact({ name: candidate.name, phone: candidate.phone })}>
                        Adicionar
                      </button>
                    </article>
                  ))}
                  {!leaderCandidates.length ? <p className="adminx-empty-text">Nenhum candidato novo detectado.</p> : null}
                </div>
                <div className="adminx-leader-list">
                  {leaders.map((leader) => (
                    <article key={leader.phone}>
                      <div>
                        <strong>{leader.name}</strong>
                        <span>{leader.phone}</span>
                      </div>
                      <button className="button danger" disabled={busy} type="button" onClick={() => removeLeader(leader.phone)}>
                        Remover
                      </button>
                    </article>
                  ))}
                  {!leaders.length ? <p className="adminx-empty-text">Nenhum líder configurado.</p> : null}
                </div>
              </section>
            </article>
          </section>
        ) : null}
      </section>

      <nav className="adminx-bottom-nav">
        {pages.map(({ id, label, Icon, badge }) => (
          <button className={page === id ? "active" : ""} key={id} type="button" onClick={() => { setPage(id); if (id === "validations" || id === "reactions") setDecisionFilter("all"); }}>
            {badge ? <b>{badge}</b> : null}
            <Icon size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {rejectRequest ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog adminx-reject-dialog" role="dialog" aria-modal="true" aria-labelledby="adminx-reject-title">
            <p className="panel-label">Motivo obrigatório</p>
            <h2 id="adminx-reject-title">{rejectRequest.title}</h2>
            <p className="confirmation-message">Escreva o motivo da rejeição. Esse texto fica salvo na auditoria da rota.</p>
            <textarea
              className="incident-textarea"
              autoFocus
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Ex.: líder removeu a reação porque a rota estava duplicada; mensagem enviada no grupo errado; rota não conferiu..."
            />
            <div className="confirmation-actions">
              <button className="button" disabled={busy} type="button" onClick={() => setRejectRequest(undefined)}>Cancelar</button>
              <button className="button danger" disabled={busy || rejectReason.trim().length < 3} type="button" onClick={confirmReject}>
                Rejeitar {rejectRequest.routeIds.length} rota(s)
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {routeDetail ? <RouteSidePanel route={routeDetail} onClose={() => setRouteDetail(undefined)} onValidate={(id) => decideRoute(id, "validate")} onReject={(id) => requestReject([id])} /> : null}
      {clientDetail ? <ClientSidePanel detail={clientDetail} busy={busy} onClose={() => setClientDetail(undefined)} onAction={runClientAction} /> : null}
      {toast ? <div className="action-toast">{toast}</div> : null}
    </main>
  );
}

function RouteFilters({
  decisionFilter,
  modeFilter,
  onDecision,
  onMode
}: {
  decisionFilter: DecisionFilter;
  modeFilter: ModeFilter;
  onDecision: (value: DecisionFilter) => void;
  onMode: (value: ModeFilter) => void;
}) {
  return (
    <div className="adminx-page-actions">
      <select value={decisionFilter} onChange={(event) => onDecision(event.target.value as DecisionFilter)}>
        <option value="all">Todos status</option>
        <option value="pending">Pendentes</option>
        <option value="validated">Validadas</option>
        <option value="rejected">Rejeitadas</option>
        <option value="leader">Com reação</option>
        <option value="removed">Reação removida</option>
      </select>
      <select value={modeFilter} onChange={(event) => onMode(event.target.value as ModeFilter)}>
        <option value="all">Todas origens</option>
        <option value="target">Todos os envios reais</option>
        <option value="test">Teste</option>
        <option value="manual">Envio manual pelo painel</option>
        <option value="automatic">Rota configurada automática</option>
        <option value="ocr">Imagem IA</option>
        <option value="warmup">Aquecimento</option>
        <option value="simulation">Simulação</option>
      </select>
    </div>
  );
}

function RouteTable({
  routes,
  selectedRoutes,
  compact = false,
  readOnly = false,
  onSelect,
  onOpen,
  onValidate,
  onReject
}: {
  routes: RouteDispatch[];
  selectedRoutes: string[];
  compact?: boolean;
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onOpen: (route: RouteDispatch) => void;
  onValidate: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className={compact ? "adminx-table-wrap compact" : "adminx-table-wrap"}>
      <table className="adminx-table">
        <thead>
          <tr>
            {!readOnly ? <th /> : null}
            <th>Cliente</th>
            <th>Modo</th>
            <th>Trigger</th>
            <th>Grupo</th>
            <th>Mensagens</th>
            <th>Status Final da Reação</th>
            <th>Validação</th>
            <th>Envio</th>
            <th>Data</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((route) => (
            <tr className={`${isRealValidationRoute(route) ? "adminx-route-important" : ""} adminx-route-${routeAgeState(route)}`} key={route.id} style={colorStyle(route.clientColor)}>
              {!readOnly ? <td data-label="Selecionar"><input type="checkbox" checked={selectedRoutes.includes(route.id)} onChange={() => onSelect(route.id)} /></td> : null}
              <td data-label="Cliente"><span className="adminx-client-dot" />{route.clientEmail}</td>
              <td data-label="Modo">{route.ocr ? <StatusPill tone="blue">Imagem</StatusPill> : <StatusPill tone={route.mode === "test" ? "yellow" : "green"}>{route.mode}</StatusPill>}</td>
              <td data-label="Trigger">{triggerLabel(route)}</td>
              <td data-label="Grupo">
                <div className="adminx-group-cell">
                  {isRealValidationRoute(route) ? <StatusPill tone="yellow">Motoristas</StatusPill> : null}
                  <span>{route.groupName || route.groupJid || "Sem grupo"}</span>
                </div>
              </td>
              <td data-label="Mensagens"><button className="adminx-link-cell" type="button" onClick={() => onOpen(route)}>{route.messages.join(" | ") || "Sem mensagem"}</button></td>
              <td data-label="Reação final">
                <StatusPill tone={route.lastReactionState?.status === "removed" ? "yellow" : route.reactions.length ? "green" : "muted"}>{reactionFinalLabel(route)}</StatusPill>
                {clientIncidentSummary(route) ? <small className="adminx-cell-note">{clientIncidentSummary(route)}</small> : null}
              </td>
              <td data-label="Validação"><StatusPill tone={routeDecision(route) === "validated" ? "green" : routeDecision(route) === "rejected" ? "red" : "yellow"}>{routeDecisionLabel(route)}</StatusPill></td>
              <td data-label="Envio">{route.confirmedCount}/{route.totalCount} - {route.status}</td>
              <td data-label="Data">{formatShort(route.createdAt)}</td>
              <td data-label="Ações">
                <div className="adminx-row-actions">
                  <button className="button" type="button" onClick={() => onOpen(route)}>Ver</button>
                  {!readOnly ? <button className="button primary" type="button" onClick={() => onValidate(route.id)}>Validar</button> : null}
                  {!readOnly ? <button className="button danger" type="button" onClick={() => onReject(route.id)}>Rejeitar</button> : null}
                </div>
              </td>
            </tr>
          ))}
          {!routes.length ? (
            <tr><td colSpan={readOnly ? 10 : 11}><p className="adminx-empty-text">Nenhuma rota encontrada.</p></td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTable({
  users,
  onOpen,
  onEdit,
  onToggleBlock
}: {
  users: AdminUserSummary[];
  onOpen: (email: string) => void;
  onEdit: (user: AdminUserSummary) => void;
  onToggleBlock: (user: AdminUserSummary) => void;
}) {
  return (
    <div className="adminx-table-wrap">
      <table className="adminx-table">
        <thead>
          <tr>
            <th>Usuário</th>
            <th>Role</th>
            <th>Painel</th>
            <th>Bot</th>
            <th>Monitoramento</th>
            <th>Prioridade</th>
            <th>Último visto</th>
            <th>Uso</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.email} style={colorStyle(user.color)}>
              <td data-label="Usuário"><span className="adminx-client-dot" />{user.email}</td>
              <td data-label="Role">{user.role}</td>
              <td data-label="Painel"><StatusPill tone={user.blocked ? "red" : user.presenceStatus === "online" ? "green" : user.presenceStatus === "recent" ? "yellow" : "muted"}>{user.blocked ? "bloqueado" : user.presenceStatus}</StatusPill></td>
              <td data-label="Bot">{user.botStatus || "fechado"}</td>
              <td data-label="Monitoramento">{user.monitoringEnabled ? <StatusPill tone="green">ativo</StatusPill> : <StatusPill tone="muted">parado</StatusPill>}</td>
              <td data-label="Confronto">{user.dispatchMatchups?.length ? user.dispatchMatchups.map((rule) => `${rule.outcome === "wins" ? "Ganha de" : "Perde para"} ${rule.opponentEmail} · ${rule.delayMs}ms`).join(" | ") : "Sem confrontos"}</td>
              <td data-label="Último visto">{formatShort(user.lastSeenAt)}</td>
              <td data-label="Uso">{formatDuration(user.totalUsageMs)}</td>
              <td data-label="Ações">
                <div className="adminx-row-actions">
                  <button className="button" type="button" onClick={() => onOpen(user.email)}>Detalhes</button>
                  <button className="button" type="button" onClick={() => onEdit(user)}>Editar</button>
                  <button className={user.blocked ? "button primary" : "button danger"} type="button" onClick={() => onToggleBlock(user)}>{user.blocked ? "Liberar" : "Bloquear"}</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogList({ logs, full = false }: { logs: AdminLogEntry[]; full?: boolean }) {
  return (
    <div className={full ? "adminx-log-list full" : "adminx-log-list"}>
      {logs.map((log) => (
        <article className={`adminx-log-row adminx-log-${log.level}`} key={`${log.clientEmail}-${log.id}`} style={colorStyle(log.clientColor)}>
          <span>{formatShort(log.timestamp)}</span>
          <b>{log.clientEmail}</b>
          <p>{uiText(log.message)}</p>
        </article>
      ))}
      {!logs.length ? <p className="adminx-empty-text">Nenhum log encontrado.</p> : null}
    </div>
  );
}

function SupportList({ messages, onRead }: { messages: SupportMessage[]; onRead: (id: string) => void }) {
  return (
    <div className="adminx-support-list">
      {messages.map((message) => (
        <article className={message.read ? "adminx-support-row" : "adminx-support-row unread"} key={message.id} style={colorStyle(message.clientColor)}>
          <div>
            <span className="adminx-client-dot" />
            <strong>{message.email}</strong>
            <small>{formatDate(message.createdAt)}</small>
          </div>
          <p>{message.message}</p>
          <small>{message.userAgent || "Sem user-agent"}</small>
          {!message.read ? <button className="button" type="button" onClick={() => onRead(message.id)}>Marcar lida</button> : null}
        </article>
      ))}
      {!messages.length ? <p className="adminx-empty-text">Nenhuma mensagem de suporte.</p> : null}
    </div>
  );
}

function FunnelPanel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, steps[0]?.value || 0);
  return (
    <div className="adminx-funnel">
      {steps.map((step) => (
        <article key={step.label}>
          <div>
            <strong>{step.value}</strong>
            <span>{step.label}</span>
          </div>
          <i style={{ width: `${Math.max(6, Math.round((step.value / max) * 100))}%` }} />
        </article>
      ))}
    </div>
  );
}

function ClientScoreList({
  items,
  onOpen
}: {
  items: Array<{
    client: AdminUserSummary;
    score: number;
    risk: string;
    routes: RouteDispatch[];
    valid: number;
    pending: number;
    pickup: number;
    paceProjection: number;
    topRoutes: Array<{ label: string; count: number }>;
  }>;
  onOpen: (email: string) => void;
}) {
  return (
    <div className="adminx-score-list">
      {items.map((item) => (
        <button key={item.client.email} type="button" onClick={() => onOpen(item.client.email)} style={colorStyle(item.client.color)}>
          <span className={item.score >= 75 ? "adminx-score good" : item.score >= 55 ? "adminx-score warn" : "adminx-score bad"}>{item.score}</span>
          <div>
            <strong>{item.client.email}</strong>
            <small>{item.risk} - {item.valid}/{item.routes.length} válidas - {item.pickup}% envio</small>
            <small>{item.topRoutes.length ? item.topRoutes.map((route) => `${route.label} ${route.count}x`).join(" | ") : "sem rotas no filtro"}</small>
          </div>
          <b>{item.paceProjection}</b>
        </button>
      ))}
      {!items.length ? <p className="adminx-empty-text">Nenhum cliente nesse filtro.</p> : null}
    </div>
  );
}

function ReportTable({ clients, routes }: { clients: AdminUserSummary[]; routes: RouteDispatch[] }) {
  const rows = clients.map((client) => {
    const clientRoutes = routes.filter((route) => route.clientEmail === client.email);
    const valid = clientRoutes.filter((route) => routeDecision(route) === "validated").length;
    const rejected = clientRoutes.filter((route) => routeDecision(route) === "rejected").length;
    const pending = clientRoutes.filter((route) => routeDecision(route) === "pending").length;
    const leader = clientRoutes.filter(hasLeaderReaction).length;
    const sent = clientRoutes.filter((route) => route.confirmedCount > 0).length;
    const activeDays = uniqueDays(clientRoutes);
    const removed = clientRoutes.filter((route) => route.lastReactionState?.status === "removed").length;
    const notAcceptable = clientRoutes.reduce((total, route) => total + (route.dispatchTimeline?.notAcceptableCount || 0), 0);
    const rate = clientRoutes.length ? Math.round((valid / clientRoutes.length) * 100) : 0;
    const pickup = clientRoutes.length ? Math.round((sent / clientRoutes.length) * 100) : 0;
    const currentDayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const projection = Math.round((clientRoutes.length / Math.max(1, currentDayOfMonth)) * daysInMonth);
    const score = Math.max(0, Math.min(100, Math.round(35 + rate * 0.3 + pickup * 0.22 + Math.min(15, activeDays * 2) + (client.monitoringEnabled ? 8 : 0) - rejected * 3 - pending * 1.2 - removed * 4 - notAcceptable * 1.5)));
    const risk = !client.monitoringEnabled ? "Bot parado" : notAcceptable >= 3 ? "WA recusando" : pending >= 5 ? "Pendência alta" : score >= 75 ? "Saudável" : "Atenção";
    return { client, clientRoutes, valid, rejected, pending, leader, sent, activeDays, rate, pickup, projection, score, risk, topRoutes: topLabels(clientRoutes, 2) };
  }).sort((a, b) => b.score - a.score || b.valid - a.valid || b.clientRoutes.length - a.clientRoutes.length);

  return (
    <div className="adminx-table-wrap">
      <table className="adminx-table">
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Score</th>
            <th>Total</th>
            <th>Pegas</th>
            <th>Validadas</th>
            <th>Pendentes</th>
            <th>Rejeitadas</th>
            <th>Reações líder</th>
            <th>Taxa</th>
            <th>Projeção</th>
            <th>Rotas fortes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.client.email} style={colorStyle(row.client.color)}>
              <td data-label="Cliente"><span className="adminx-client-dot" />{row.client.email}</td>
              <td data-label="Score"><StatusPill tone={row.score >= 75 ? "green" : row.score >= 55 ? "yellow" : "red"}>{row.score} · {row.risk}</StatusPill></td>
              <td data-label="Total">{row.clientRoutes.length}</td>
              <td data-label="Pegas">{row.sent} · {row.pickup}%</td>
              <td data-label="Validadas">{row.valid}</td>
              <td data-label="Pendentes">{row.pending}</td>
              <td data-label="Rejeitadas">{row.rejected}</td>
              <td data-label="Reações líder">{row.leader}</td>
              <td data-label="Taxa">{row.rate}%</td>
              <td data-label="Projeção">{row.projection}</td>
              <td data-label="Rotas fortes">{row.topRoutes.map((route) => `${route.label} ${route.count}x`).join(" | ") || "sem recorrência"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
