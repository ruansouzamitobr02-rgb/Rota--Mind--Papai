import { PANEL_SESSION_CHANGED, revokePanelSession } from "./api";
import { getRouteDecisionStatus, isRouteDeleted } from "../../shared/routeLifecycle";
import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  Bell,
  Bot,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  Edit3,
  Gauge,
  Home,
  Info,
  LockKeyhole,
  LogOut,
  Mail,
  MessageSquareText,
  MoreVertical,
  RefreshCw,
  Route,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Skull,
  Sparkles,
  SlidersHorizontal,
  TestTube2,
  Trash2,
  UserPlus,
  X,
  Wifi,
  WifiOff,
  Zap
} from "lucide-react";
import {
  AdminRoutesSnapshot,
  AdminLogEntry,
  AdminSupportMessagesSnapshot,
  AdminUserDetail,
  AdminUserSummary,
  AdminUsersSnapshot,
  AppRelease,
  BotConfig,
  BotSnapshot,
  MonitoredRoute,
  OcrRouteSelectionState,
  PanelUserRole,
  RouteDispatch,
  SupportMessage
} from "../../shared/types";
import { ControlButtons } from "./components/ControlButtons";
import { GroupMessageCard } from "./components/GroupMessageCard";
import { AnalysisImage } from "./components/AnalysisImage";
import { LogsPanel } from "./components/LogsPanel";
import { QrCodeBox } from "./components/QrCodeBox";
import { SettingsPanel } from "./components/SettingsPanel";
import { AdminCommandCenter } from "./admin/AdminCommandCenter";
import { getAdminDatePreset, isDateInsideAdminRange } from "./adminDateFilter";
import { enableWebPushNotifications } from "./pushNotifications";
import { uiText } from "./uiText";
import { getEnabledNeighborhoodPreferences, getNeighborhoodPreferences, neighborhoodPreferenceLabel, normalizeNeighborhoodPreferences } from "./neighborhoodPreferences";
import {
  acknowledgeRelease,
  botApi,
  clearAdminMaintenance,
  enterClientMode,
  getAdminMonitor,
  getAdminUserDetail,
  getPanelMe,
  getReleaseNotice,
  getPanelToken,
  getPanelUserEmail,
  getPanelUserRole,
  isAuthError,
  markSupportMessageRead,
  panelLogin,
  rejectAdminRoute,
  returnToAdminMode,
  saveAdminUser,
  sendSupportMessage,
  setPanelPassword,
  setPanelToken,
  setPanelUserEmail,
  setPanelUserRole,
  subscribeAdminMonitor,
  validateAdminRoute
} from "./api";
import "./styles.css";

function useEdgeSwipeBack(onBack: () => void, enabled = true) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tracking = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || event.touches[0].clientX > 36) {
        tracking = false;
        return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startedAt = Date.now();
      tracking = true;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const deltaX = event.touches[0].clientX - startX;
      const deltaY = Math.abs(event.touches[0].clientY - startY);
      if (deltaX > 18 && deltaX > deltaY * 1.4) event.preventDefault();
      if (deltaY > 90 && deltaY > deltaX) tracking = false;
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - startX;
      const deltaY = Math.abs(touch.clientY - startY);
      if (deltaX >= 78 && deltaX > deltaY * 1.5 && Date.now() - startedAt <= 800) onBackRef.current();
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      document.removeEventListener("touchend", onTouchEnd, true);
    };
  }, [enabled]);
}

type PendingConfirmation = {
  title: string;
  message: string;
  details: string[];
  confirmLabel: string;
  tone?: "manual" | "auto";
  onConfirm: () => void | Promise<void>;
};

type ActionToast = {
  message: string;
  tone?: "manual" | "auto";
};

type AppTab = "home" | "groups" | "image" | "test" | "settings";
type GroupEditor = "target" | "image" | "test" | undefined;
type AdminSection = "overview" | "reactions" | "logs" | "routes" | "users" | "support" | "settings" | undefined;
type AdminMainTab = "dashboard" | "validations" | "history" | "logs" | "reports" | "clients" | "settings";
type RouteStatusFilter = "all" | "pending" | "validated" | "rejected" | "leader";
type RouteKindFilter = "all" | "automatic" | "manual" | "test";
type RouteHistoryTab = "automatic" | "manual" | "test";
type CleanupTarget = "logs" | "routes" | "support" | "all";
type AdminLogLevelFilter = "all" | "info" | "success" | "warning" | "error";

const emptySnapshot: BotSnapshot = {
  status: "disconnected",
  groupState: "unknown",
  qrCode: "",
  config: {
    grupoAlvoJid: "",
    grupoAlvoNome: "",
    grupoTesteJid: "",
    grupoTesteNome: "",
    nomeEnvio: "",
    targetDispatchMode: "manual",
    nuclearMode: false,
    codigosMensagensAlvo: [],
    rotasMonitoradas: [],
    rotasMonitoradasDetalhadas: [],
    routePresets: [],
    codigosMensagensTeste: [],
    testMessageCount: 15,
    testMessageIntervalMs: 0,
    fastMode: true,
    minSendDelayMs: 0,
    alwaysWarmMode: true,
    keepAliveIntervalMs: 300000,
    ocrManualRouteSelection: false,
    ocrSelectionMode: "neighborhoods",
    ocrDesiredCages: [],
    ocrCageMessageLimit: 3,
    ocrMaxStops: 0,
    ocrMaxPackages: 0,
    ocrRouteChoiceMode: "quantity",
    ocrRouteChoiceMetric: "stops"
  },
  groups: [],
  readinessChecks: [],
  logs: [],
  testStatus: {
    active: false,
    lastSentCount: 0,
    lastFailedCount: 0,
    configuredMessageCount: 15,
    intervalMs: 0
  },
  performanceMetrics: {
    lastDispatchLatencyMs: 0,
    averageDispatchLatencyMs: 0,
    lastDispatchDurationMs: 0,
    averageMessageSendMs: 0,
    dispatchCount: 0,
    sentMessages: 0,
    failedMessages: 0,
    activeQueue: 0
  }
};

const tabs: Array<{ id: AppTab; label: string; Icon: typeof Home }> = [
  { id: "home", label: "Inicio", Icon: Home },
  { id: "image", label: "Imagem", Icon: Sparkles },
  { id: "test", label: "Teste", Icon: TestTube2 },
  { id: "settings", label: "Ajustes", Icon: Settings }
];

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonthStartInput() {
  const now = new Date();
  return toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
}

function parseDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T23:59:59.999`);
  const startMs = Number.isNaN(start.getTime()) ? 0 : start.getTime();
  const endMs = Number.isNaN(end.getTime()) ? Date.now() : end.getTime();
  return {
    startMs: Math.min(startMs, endMs),
    endMs: Math.max(startMs, endMs)
  };
}

function formatReportDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const format = (date: Date) => Number.isNaN(date.getTime()) ? "--/--/----" : date.toLocaleDateString("pt-BR");
  return `${format(start)} ate ${format(end)}`;
}

function normalizeMessages(senderName: string, codes: string[]) {
  return codes.map((code) => `${senderName.trim()} ${code.trim().toUpperCase()}`.trim()).filter(Boolean);
}

function formatOcrRoutes(routes: string[] = [], detailedRoutes: MonitoredRoute[] = []) {
  if (detailedRoutes.length) return detailedRoutes.map((route) => route.cidade ? `${route.cidade} / ${route.bairro}` : route.bairro);
  return routes;
}

function MessagePreviewStrip({
  title,
  group,
  messages,
  onOpen
}: {
  title: string;
  group: string;
  messages: string[];
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="message-strip">
      <button className="message-strip-main" type="button" onClick={() => setExpanded((value) => !value)}>
        <span>
          <strong>{title}</strong>
          <small>{group}</small>
        </span>
        <b>{messages.length}</b>
      </button>
      {expanded ? (
        <div className="message-strip-body">
          {messages.length ? messages.map((message, index) => <span key={`${message}-${index}`}>{uiText(message)}</span>) : <span>Nenhuma mensagem salva.</span>}
          <button className="link-button" type="button" onClick={onOpen}>
            Editar
          </button>
        </div>
      ) : null}
    </article>
  );
}

function LoginScreen({ error, onSubmit }: { error?: string; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [supportMessage, setSupportMessage] = useState("Meu acesso está bloqueado. Pode liberar minha conta?");
  const [supportStatus, setSupportStatus] = useState("");
  const blocked = Boolean(error && /bloquead/i.test(error));

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(email.trim(), password);
  }

  async function requestSupport() {
    setSupportStatus("");
    try {
      await sendSupportMessage({ email: email.trim(), message: supportMessage });
      setSupportStatus("Mensagem enviada para o admin pelo painel.");
    } catch (supportError) {
      setSupportStatus(supportError instanceof Error ? supportError.message : "Não consegui enviar a mensagem.");
    }
  }

  return (
    <main className="login-shell">
      <ParticleBackdrop />
      <ElectricCracks />
      <ForegroundSparks />
      <div className="bot-ambient" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-logo" aria-hidden="true">
          <img src="/br-skull-icon-192-v6.png" alt="" />
          <span>RX</span>
        </div>
        <div className="login-heading">
          <p className="panel-label">Acesso seguro</p>
          <h1>Bot Rotas</h1>
          <span>Central dark de operação e monitoramento</span>
        </div>
        <div className="login-field">
          <Mail size={18} />
          <input
            autoComplete="email"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="login-field">
          <LockKeyhole size={18} />
          <input
            autoComplete="current-password"
            autoFocus
            placeholder="Senha"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {blocked ? (
          <section className="blocked-access-card">
            <strong>Acesso pausado</strong>
            <p>Seu usuário está bloqueado no momento. Envie uma mensagem interna para o admin solicitar liberação.</p>
            <textarea
              value={supportMessage}
              onChange={(event) => setSupportMessage(event.target.value)}
              placeholder="Escreva sua mensagem para o admin"
            />
            <button className="button primary" disabled={!email.trim() || !supportMessage.trim()} type="button" onClick={requestSupport}>
              <MessageSquareText size={18} />
              Enviar para o admin
            </button>
            {supportStatus ? <span className="support-unavailable">{supportStatus}</span> : null}
          </section>
        ) : error ? <p className="login-error">{error}</p> : null}
        <button className="button primary" disabled={!email.trim() || !password} type="submit">
          <LockKeyhole size={18} />
          Entrar
        </button>
      </form>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-shell">
      <section className="loading-panel">
        <div className="brand-logo" aria-hidden="true">
          <img src="/br-skull-icon-192-v6.png" alt="" />
          <span>BR</span>
        </div>
        <span className="loading-spinner" aria-hidden="true" />
        <div>
          <p className="panel-label">Abrindo painel</p>
          <h1>Validando sessão</h1>
          <p>Carregando seu acesso salvo.</p>
        </div>
      </section>
    </main>
  );
}

function ConfigStrip({
  kind,
  title,
  group,
  codes,
  onOpen
}: {
  kind: "target" | "test";
  title: string;
  group: string;
  codes: string[];
  onOpen: () => void;
}) {
  const Icon = kind === "target" ? MessageSquareText : TestTube2;

  return (
    <button className={`config-strip config-strip-${kind}`} type="button" onClick={onOpen}>
      <span className="strip-icon">
        <Icon size={20} />
      </span>
      <span className="strip-copy">
        <strong>{title}</strong>
        <small>{group}</small>
      </span>
      <span className="strip-count">{codes.length}</span>
      <SlidersHorizontal size={20} />
    </button>
  );
}

function getLastLogTime(logs: BotSnapshot["logs"], patterns: RegExp[]) {
  const found = [...logs].reverse().find((log) => patterns.some((pattern) => pattern.test(log.message)));
  return found ? new Date(found.timestamp).toLocaleTimeString("pt-BR") : "Sem registro";
}

function countConfirmedMessages(logs: BotSnapshot["logs"]) {
  return logs.filter((log) => /Mensagem (alvo )?\d+ .*?(confirmada|enviada)/i.test(log.message)).length;
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("pt-BR") : "Sem registro";
}

function formatShortDate(value?: string) {
  return value
    ? new Date(value).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "Sem registro";
}

const INCIDENT_SNOOZE_DELAYS_MINUTES = [10, 5, 2];

function isClientIncidentDue(route: RouteDispatch, now = Date.now()) {
  const incident = route.clientIncident;
  if (!incident?.required || incident.answeredAt) return false;
  if (!incident.snoozedUntil) return true;
  const dueAt = new Date(incident.snoozedUntil).getTime();
  return !Number.isFinite(dueAt) || dueAt <= now;
}

function getIncidentSnoozeDelayMinutes(route: RouteDispatch) {
  const count = Math.max(0, Number(route.clientIncident?.snoozeCount || 0));
  return INCIDENT_SNOOZE_DELAYS_MINUTES[count];
}

function getIncidentAuditLines(route: RouteDispatch) {
  const incident = route.clientIncident;
  const removedLeaderEvents = (route.reactionsHistory || []).filter((reaction) => reaction.action === "remove" && reaction.isAdmin);
  const lastRemovedLeader = removedLeaderEvents[removedLeaderEvents.length - 1];
  const lastReaction = route.lastReactionState;
  const deletedIds = route.deletedMessageIds || [];
  const lines = [
    `Evento criado: ${formatDate(incident?.createdAt)}`,
    `Envio original: ${formatDate(route.createdAt)}`,
    `Grupo: ${route.groupName || route.groupJid || "Não identificado"}`,
    `Status do envio: ${route.confirmedCount}/${route.totalCount} confirmada(s), status ${route.status}`,
    `Modo: ${route.ocr ? "Bot imagem/análise visual" : route.mode === "test" ? "Teste/aquecimento" : "Grupo alvo"}`,
    `Trigger: ${route.trigger || (route.mode === "test" ? "warmup" : "automatic")}`
  ];

  if (incident?.kind === "message_deleted") {
    lines.push(`Mensagem apagada: ${deletedIds.length ? deletedIds.join(", ") : "ID não identificado"}`);
  }

  if (lastRemovedLeader) {
    lines.push(`Quem removeu: ${lastRemovedLeader.leaderName || lastRemovedLeader.senderPhone || "Líder identificado"}`);
    lines.push(`Horário da remoção: ${formatDate(lastRemovedLeader.timestamp)}`);
    lines.push(`Emoji removido: ${lastRemovedLeader.emoji || "Reação sem emoji"}`);
  } else if (lastReaction?.status === "removed") {
    lines.push(`Última reação removida: ${lastReaction.leaderName || lastReaction.senderPhone || "Remetente identificado"}`);
    lines.push(`Horário da remoção: ${formatDate(lastReaction.updatedAt)}`);
  }

  if (route.messages.length) lines.push(`Mensagem enviada: ${route.messages.join(" | ")}`);
  if (route.sentMessageIds.length) lines.push(`IDs enviados: ${route.sentMessageIds.join(", ")}`);
  if (incident?.snoozeCount) lines.push(`Adiamentos usados: ${incident.snoozeCount}/3`);
  if (incident?.snoozedUntil) lines.push(`Último prazo: ${formatDate(incident.snoozedUntil)}`);
  return lines;
}

function formatDuration(ms: number) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}min`;
  if (hours) return `${hours}h`;
  return `${minutes}min`;
}

function getPresenceCopy(user: AdminUserSummary) {
  if (user.blocked) return "bloqueado";
  if (user.presenceStatus === "online") return "online agora";
  if (user.presenceStatus === "recent") return "ativo recente";
  return "offline";
}

function getBotOpenCopy(user: AdminUserSummary) {
  if (user.botOpen && user.monitoringEnabled) return "bot ligado";
  if (user.botOpen) return "painel do bot aberto";
  return "bot fechado";
}

function colorStyle(color?: string): CSSProperties {
  return { "--client-color": color || "#7eb6ff" } as CSSProperties;
}

function OperationStep({
  title,
  detail,
  state,
  Icon
}: {
  title: string;
  detail: string;
  state: "done" | "active" | "waiting" | "error";
  Icon: typeof Home;
}) {
  return (
    <article className={`operation-step step-${state}`}>
      <span className="operation-icon">
        {state === "done" ? <CheckCircle2 size={19} /> : state === "error" ? <AlertTriangle size={19} /> : <Icon size={19} />}
      </span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function CockpitPanel({
  snapshot,
  groupLabel
}: {
  snapshot: BotSnapshot;
  groupLabel: string;
}) {
  const connected = snapshot.status === "connected";
  const connectionWaiting = snapshot.status === "connecting" || snapshot.status === "waiting_qr" || snapshot.status === "reconnecting";
  const hasGroup = Boolean(snapshot.config.grupoAlvoJid || snapshot.config.grupoAlvoNome);
  const hasMessages = Boolean(snapshot.config.nomeEnvio && snapshot.config.codigosMensagensAlvo?.length);
  const armed = Boolean(snapshot.monitoringEnabled);
  const lastOpening = getLastLogTime(snapshot.logs, [/ABRIU/i, /Palavra de abertura/i, /Abertura simulada/i]);
  const confirmed = countConfirmedMessages(snapshot.logs);

  return (
    <section className="operation-panel" aria-label="Resumo operacional">
      <div className="operation-heading">
        <div>
          <p className="panel-label">Agora</p>
          <h2>{armed ? "Bot armado e ouvindo o grupo" : connected ? "Pronto para iniciar" : connectionWaiting ? "Conectando WhatsApp" : "Conecte o WhatsApp"}</h2>
        </div>
        <span className={armed ? "live-badge active" : "live-badge"}>{armed ? "Ao vivo" : "Parado"}</span>
      </div>
      <div className="operation-steps">
        <OperationStep
          Icon={connected ? Wifi : WifiOff}
          state={snapshot.status === "error" ? "error" : connected ? "done" : connectionWaiting ? "active" : "waiting"}
          title="WhatsApp"
          detail={connected ? "Conectado" : snapshot.status === "waiting_qr" ? "Leia o QR Code" : "Aguardando conexão"}
        />
        <OperationStep
          Icon={ShieldCheck}
          state={hasGroup ? "done" : "waiting"}
          title="Rota"
          detail={hasGroup ? groupLabel : "Escolha o grupo alvo"}
        />
        <OperationStep
          Icon={MessageSquareText}
          state={hasMessages ? "done" : "waiting"}
          title="Mensagens"
          detail={hasMessages ? `${snapshot.config.codigosMensagensAlvo.length} pronta(s)` : "Configure nome e códigos"}
        />
        <OperationStep
          Icon={Send}
          state={armed ? "active" : "waiting"}
          title="Disparo"
          detail={armed ? `Última abertura: ${lastOpening}` : `${confirmed} mensagem(ns) confirmadas`}
        />
      </div>
    </section>
  );
}

function ParticleBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    let width = 0;
    let height = 0;
    let frame = 0;
    let compact = false;
    let maxDistance = 142;
    let lastDrawAt = 0;
    let nodes: Array<{ x: number; y: number; vx: number; vy: number; r: number }> = [];

    function createNodes() {
      compact = window.innerWidth < 720;
      const count = compact ? 62 : 128;
      maxDistance = compact ? 108 : 164;
      const speed = compact ? 2.7 : 1.7;
      nodes = Array.from({ length: count }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        r: compact ? Math.random() * 1.25 + 0.7 : Math.random() * 1.25 + 0.65
      }));
    }

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 720 ? 1.25 : 2);
      const wasCompact = compact;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (!nodes.length || wasCompact !== window.innerWidth < 720) createNodes();
    }

    function draw(timestamp: number) {
      frame = window.requestAnimationFrame(draw);
      if (compact && timestamp - lastDrawAt < 32) return;
      lastDrawAt = timestamp;
      context.clearRect(0, 0, width, height);
      const accent = [155, 92, 255];
      const secondary = [210, 181, 255];

      nodes.forEach((node, index) => {
        node.x += node.vx / Math.max(width, 1);
        node.y += node.vy / Math.max(height, 1);
        if (node.x < 0 || node.x > 1) node.vx *= -1;
        if (node.y < 0 || node.y > 1) node.vy *= -1;

        const x = node.x * width;
        const y = node.y * height;
        context.beginPath();
        context.arc(x, y, node.r, 0, Math.PI * 2);
        context.fillStyle = `rgba(${accent.join(",")},${compact ? 0.86 : 0.7})`;
        context.fill();

        for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
          const next = nodes[nextIndex];
          const nx = next.x * width;
          const ny = next.y * height;
          const distance = Math.hypot(x - nx, y - ny);
          if (distance > maxDistance) continue;
          const opacity = (1 - distance / maxDistance) * (compact ? 0.42 : 0.34);
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(nx, ny);
          context.strokeStyle = `rgba(${index % 3 === 0 ? secondary.join(",") : accent.join(",")},${opacity})`;
          context.lineWidth = 0.7;
          context.stroke();
        }
      });

    }

    createNodes();
    resize();
    frame = window.requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas className="bot-particle-field" ref={canvasRef} aria-hidden="true" />;
}

function ElectricCracks() {
  const paths = [
    "M0 155 L92 184 L158 150 L228 238 L310 214 L385 302 L468 285",
    "M158 150 L176 84 L235 42",
    "M228 238 L187 302 L205 367",
    "M1000 118 L923 164 L862 145 L806 228 L724 207 L657 286",
    "M806 228 L842 304 L817 378",
    "M1000 716 L914 681 L849 730 L766 692 L687 778 L608 752",
    "M0 842 L83 796 L145 824 L218 742 L292 771"
  ];
  return (
    <svg className="electric-cracks" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="crack-violet" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4b257d" stopOpacity="0" />
          <stop offset="0.38" stopColor="#9b5cff" />
          <stop offset="0.72" stopColor="#d2b5ff" />
          <stop offset="1" stopColor="#6b34b5" stopOpacity="0" />
        </linearGradient>
        <filter id="crack-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g className="crack-base">{paths.map((path, index) => <path d={path} key={`base-${index}`} />)}</g>
      <g className="crack-energy" filter="url(#crack-glow)">{paths.map((path, index) => <path d={path} key={`energy-${index}`} style={{ animationDelay: `${index * 620}ms` }} />)}</g>
    </svg>
  );
}

function ForegroundSparks() {
  return (
    <div className="foreground-sparks" aria-hidden="true">
      {Array.from({ length: 14 }, (_, index) => (
        <i
          key={index}
          style={{
            "--spark-index": index,
            "--spark-delay": `${-(index * 0.73) % 5.8}s`,
            "--spark-duration": `${3.1 + (index % 5) * 0.46}s`,
            "--spark-y": `${5 + ((index * 19) % 88)}dvh`,
            "--spark-size": `${2 + (index % 3) * 0.7}px`,
            "--spark-trail": `${13 + (index % 4) * 5}px`,
            "--spark-angle": `${-8 + (index % 4) * 5}deg`
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

function EngineVisualPanel({ snapshot }: { snapshot: BotSnapshot }) {
  const metrics = snapshot.performanceMetrics || emptySnapshot.performanceMetrics!;
  const armed = Boolean(snapshot.monitoringEnabled);
  const connected = snapshot.status === "connected";
  const warm = metrics.internalWarmState === "ready";
  const engineTone = armed ? "live" : connected ? "ready" : "idle";

  return (
    <section className={`engine-visual-panel engine-${engineTone}`} aria-label="Motor visual do bot">
      <div className="engine-core">
        <span className="engine-ring" />
        <span className="engine-pulse" />
        <Skull size={28} />
      </div>
      <div className="engine-copy">
        <p className="panel-label">Engine</p>
        <h2>{armed ? "Monitoramento em tempo real" : connected ? "Motor pronto para largar" : "Motor em espera"}</h2>
        <div className="engine-readouts">
          <span><b>{connected ? "online" : snapshot.status}</b> conexão</span>
          <span><b>{warm ? "quente" : metrics.internalWarmState || "frio"}</b> sessão</span>
          <span><b>{metrics.averageFirstRelayMs || 0}ms</b> relay médio</span>
          <span><b>{metrics.dispatchSuccessRate || 0}%</b> entrega</span>
        </div>
      </div>
      <div className="engine-wave" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
    </section>
  );
}

function PerformanceStrip({ snapshot }: { snapshot: BotSnapshot }) {
  const metrics = snapshot.performanceMetrics || emptySnapshot.performanceMetrics!;
  const healthLabel = metrics.raceHealth === "excellent" ? "excelente" : metrics.raceHealth === "good" ? "boa" : metrics.raceHealth === "poor" ? "atenção" : metrics.raceHealth === "critical" ? "crítica" : "sem teste";
  const healthTone = metrics.raceHealth === "excellent" || metrics.raceHealth === "good" ? "green" : metrics.raceHealth === "unknown" ? "blue" : "yellow";
  const warmLabel = metrics.internalWarmState === "ready"
    ? "aquecido"
    : metrics.internalWarmState === "warming"
    ? "aquecendo"
    : "frio";
  return (
    <section className="performance-strip">
      <AdminMetric Icon={Zap} tone={healthTone} title="Saúde da corrida" value={healthLabel} detail={`${warmLabel} · loop ${metrics.eventLoopLagMs || 0}ms`} />
      <AdminMetric Icon={Gauge} tone="green" title="ACK médio" value={`${metrics.averageFirstAckMs || 0}ms`} detail={`P95 ${metrics.p95FirstAckMs || 0}ms · relay ${metrics.averageFirstRelayMs || 0}ms`} />
      <AdminMetric Icon={Activity} tone={(metrics.notAcceptableCount || 0) ? "yellow" : "blue"} title="Retorno no grupo" value={`${metrics.averageFirstGroupEchoMs || 0}ms`} detail={(metrics.notAcceptableCount || 0) ? `${metrics.notAcceptableCount} recusas` : `P95 ${metrics.p95FirstGroupEchoMs || 0}ms`} />
      <AdminMetric Icon={Wifi} tone={snapshot.status === "connected" ? "green" : "yellow"} title="Confirmação média" value={`${metrics.averageTotalDurationMs || 0}ms`} detail={`P95 ${metrics.p95TotalDurationMs || 0}ms · ${metrics.dispatchSuccessRate || 0}% entregue`} />
    </section>
  );
}

function LaunchReviewPanel({
  snapshot,
  groupLabel,
  messages,
  onEditTarget,
}: {
  snapshot: BotSnapshot;
  groupLabel: string;
  messages: string[];
  onEditTarget: () => void;
}) {
  const hasGroup = Boolean(snapshot.config.grupoAlvoJid || snapshot.config.grupoAlvoNome);
  const hasName = Boolean(snapshot.config.nomeEnvio);
  const hasMessages = messages.length > 0;
  const ocrMode = messages.some((message) => message.startsWith("OCR:"));

  return (
    <section className="quick-panel launch-review-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Revisão antes de iniciar</p>
          <h2>{ocrMode ? "Foto da rota" : "Rota e mensagens"}</h2>
        </div>
        <button className="button" type="button" onClick={onEditTarget}>
          <SlidersHorizontal size={18} />
          Editar
        </button>
      </div>
      <div className="review-grid">
        <article className={hasGroup ? "review-item ok" : "review-item pending"}>
          <span>Rota</span>
          <strong>{groupLabel}</strong>
        </article>
        <article className={hasName ? "review-item ok" : "review-item pending"}>
          <span>Nome</span>
          <strong>{snapshot.config.nomeEnvio || "Não configurado"}</strong>
        </article>
        <article className={hasMessages ? "review-item ok" : "review-item pending"}>
          <span>{ocrMode ? "Bairros preferidos" : "Mensagens"}</span>
          <strong>{messages.length ? `${messages.length} salvo(s)` : "Nenhuma"}</strong>
        </article>
      </div>
      <div className="review-messages">
        {messages.length ? messages.map((message, index) => <span key={`${message}-${index}`}>{uiText(message)}</span>) : <span>Configure a rota antes de iniciar.</span>}
      </div>
      <div className="review-actions">
        <button className="button" type="button" onClick={onEditTarget}>
          Configurar rota
        </button>
      </div>
    </section>
  );
}

function AdminMetric({
  title,
  value,
  detail,
  Icon,
  tone = "yellow"
}: {
  title: string;
  value: string | number;
  detail: string;
  Icon?: typeof Home;
  tone?: "yellow" | "green" | "blue" | "red";
}) {
  return (
    <article className={`admin-metric admin-metric-${tone}`}>
      {Icon ? (
        <span className="admin-metric-icon">
          <Icon size={19} />
        </span>
      ) : null}
      <div>
        <span>{title}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function getReactionDisplayPhone(reaction: RouteDispatch["reactions"][number]) {
  if (reaction.senderPhone && reaction.senderPhone.startsWith("55")) return reaction.senderPhone;
  const phone = (reaction.senderIdentifiers || []).find((item) => /^55\d{10,13}$/.test(item));
  return phone || reaction.senderPhone || "Número não identificado";
}

function getRouteTrigger(route: RouteDispatch) {
  if (route.trigger) return route.trigger;
  return route.mode === "test" ? "warmup" : "automatic";
}

function getRouteTriggerLabel(route: RouteDispatch) {
  const trigger = getRouteTrigger(route);
  if (trigger === "manual") return "Manual";
  if (trigger === "warmup") return "Teste 15 msgs";
  if (trigger === "target-simulation") return "Simulação alvo";
  if (trigger === "simulation") return "Simulação abertura";
  return "Automático";
}

function getRouteDecisionLabel(route: RouteDispatch) {
  const status = getRouteDecisionStatus(route);
  if (status === "deleted") return "Mensagem apagada";
  if (status === "validated") return "Validada";
  if (status === "rejected") return "Não válida";
  return "Pendente";
}

function AdminRouteHistory({
  automaticRoutes,
  manualRoutes,
  testRoutes,
  activeTab,
  onTabChange,
  onValidate,
  onReject,
  onFilterClient,
  onDetails,
  compact = false
}: {
  automaticRoutes: RouteDispatch[];
  manualRoutes: RouteDispatch[];
  testRoutes: RouteDispatch[];
  activeTab: RouteHistoryTab;
  onTabChange: (tab: RouteHistoryTab) => void;
  onValidate?: (routeId: string) => void;
  onReject?: (routeId: string) => void;
  onFilterClient?: (email: string) => void;
  onDetails?: (route: RouteDispatch) => void;
  compact?: boolean;
}) {
  const tabs: Array<{ id: RouteHistoryTab; title: string; detail: string; routes: RouteDispatch[]; Icon: typeof Home }> = [
    { id: "automatic", title: "Alvo automático", detail: "Abertura real do grupo alvo", routes: automaticRoutes, Icon: Zap },
    { id: "manual", title: "Manual / simulação", detail: "Clique manual e simulação", routes: manualRoutes, Icon: Send },
    { id: "test", title: "Teste / 15 mensagens", detail: "Aquecimento e simulação alvo", routes: testRoutes, Icon: TestTube2 }
  ];
  const active = tabs.find((tab) => tab.id === activeTab) || tabs[0];

  return (
    <section className={compact ? "admin-route-history compact" : "admin-route-history"}>
      <aside className="admin-route-tabs">
        {tabs.map(({ id, title, detail, routes, Icon }) => (
          <button className={id === active.id ? "active" : ""} key={id} type="button" onClick={() => onTabChange(id)}>
            <Icon size={18} />
            <span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </span>
            <b>{routes.length}</b>
          </button>
        ))}
      </aside>
      <div className="admin-route-history-list">
        <div className="admin-route-history-heading">
          <div>
            <p className="panel-label">Histórico de disparo</p>
            <h2>{active.title}</h2>
          </div>
          <span>{active.routes.length} registro(s)</span>
        </div>
        <div className={compact ? "admin-route-scroll compact" : "admin-route-scroll"}>
          {active.routes.length ? active.routes.map((route) => (
            compact ? (
              <button className="admin-route-feed-item" key={`route-feed-${route.id}`} type="button">
                <div className="admin-route-feed-top">
                  <span className={getRouteDecisionStatus(route) === "validated" ? "mini-badge ok" : getRouteDecisionStatus(route) === "rejected" ? "mini-badge danger" : "mini-badge"}>{getRouteDecisionLabel(route)}</span>
                  <small>{new Date(route.createdAt).toLocaleString("pt-BR")}</small>
                </div>
                <strong>{route.groupName || route.groupJid || "Grupo sem nome"}</strong>
                <small>{route.clientEmail} · {route.confirmedCount}/{route.totalCount} enviadas · {route.reactions.length} reação(ões)</small>
                <div className="admin-route-feed-messages">
                  {route.messages.map((message, index) => (
                    <span key={`${route.id}-compact-message-${index}`}>{uiText(message)}</span>
                  ))}
                </div>
                {route.reactions.length ? (
                  <div className="admin-route-feed-reactions">
                    {route.reactions.map((reaction) => (
                      <span className={reaction.isAdmin ? "leader" : ""} key={`${route.id}-compact-reaction-${reaction.id}`}>
                        <b>{reaction.emoji || "?"}</b>
                        {reaction.isAdmin
                          ? `Líder${reaction.leaderName ? ` - ${reaction.leaderName}` : ""}`
                          : getReactionDisplayPhone(reaction)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            ) : (
              <RouteRow
                key={route.id}
                route={route}
                onValidate={onValidate ? () => onValidate(route.id) : undefined}
                onReject={onReject ? () => onReject(route.id) : undefined}
                onFilterClient={onFilterClient ? () => onFilterClient(route.clientEmail) : undefined}
                onDetails={onDetails ? () => onDetails(route) : undefined}
              />
            )
          )) : <p className="qr-empty">Nenhum disparo nesse histórico.</p>}
        </div>
      </div>
    </section>
  );
}

function RouteRow({
  route,
  onValidate,
  onReject,
  onFilterClient,
  onDetails
}: {
  route: RouteDispatch;
  onValidate?: () => void;
  onReject?: () => void;
  onFilterClient?: () => void;
  onDetails?: () => void;
}) {
  const createdAt = new Date(route.createdAt).toLocaleString("pt-BR");
  const [menuOpen, setMenuOpen] = useState(false);
  const decisionStatus = getRouteDecisionStatus(route);
  const validated = decisionStatus === "validated";
  const rejected = decisionStatus === "rejected";

  return (
    <article className={validated ? "route-row validated" : rejected ? "route-row rejected" : "route-row"} style={colorStyle(route.clientColor)}>
      <div className="route-row-main">
        <span className={validated ? "route-state-icon ok" : rejected ? "route-state-icon rejected" : "route-state-icon"}>
          {validated ? <CheckCircle2 size={19} /> : rejected ? <Ban size={19} /> : <Clock3 size={19} />}
        </span>
        <div>
          <p className="panel-label client-label">
            <span className="client-color-dot" />
            {route.clientEmail || "Cliente"}
          </p>
          <h2>{route.groupName || route.groupJid || "Grupo sem nome"}</h2>
        </div>
        <span className={validated ? "route-status ok" : rejected ? "route-status rejected" : "route-status"}>{getRouteDecisionLabel(route)}</span>
        <button className="icon-button route-menu-button" title="Mais opções" type="button" onClick={() => setMenuOpen((current) => !current)}>
          <MoreVertical size={18} />
        </button>
        {menuOpen ? (
          <div className="route-menu-popover">
            {onDetails ? <button type="button" onClick={() => { setMenuOpen(false); onDetails(); }}>Ver detalhes</button> : null}
            {onFilterClient ? <button type="button" onClick={() => { setMenuOpen(false); onFilterClient(); }}>Filtrar cliente</button> : null}
            {!validated && !isRouteDeleted(route) && onValidate ? <button type="button" onClick={() => { setMenuOpen(false); onValidate(); }}>Marcar validada</button> : null}
            {!rejected && !isRouteDeleted(route) && onReject ? <button className="danger" type="button" onClick={() => { setMenuOpen(false); onReject(); }}>Não validar</button> : null}
          </div>
        ) : null}
      </div>
      <div className="route-meta">
        <span>{getRouteTriggerLabel(route)}</span>
        <span>{createdAt}</span>
        <span>{route.confirmedCount}/{route.totalCount} enviadas</span>
        <span>{route.reactions.length} reações</span>
      </div>
      <div className="route-messages">
        {route.messages.map((message, index) => (
          <span key={`${route.id}-${message}-${index}`}>{uiText(message)}</span>
        ))}
      </div>
      {route.reactions.length ? (
        <div className="reaction-stack">
          {route.reactions.map((reaction) => (
            <div className={reaction.isAdmin ? "reaction-line leader" : "reaction-line"} key={reaction.id}>
              <b>{reaction.emoji || "?"}</b>
              <span>
                <strong>
                  {reaction.isAdmin
                    ? `REAÇÃO DE LÍDER CONFIRMADA${reaction.leaderName ? ` - ${reaction.leaderName}` : ""}`
                    : "Reação comum - não é líder"}
                </strong>
                <small>{getReactionDisplayPhone(reaction)}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {decisionStatus === "pending" && (onValidate || onReject) ? (
        <div className="route-action-stack">
          {onValidate ? (
            <button className="button accent route-validate-button" type="button" onClick={onValidate}>
              <CheckCircle2 size={18} />
              Validar
            </button>
          ) : null}
          <button className="button route-review-button" type="button">
            Revisar
          </button>
          {onReject ? (
            <button className="button danger route-reject-button" type="button" onClick={onReject}>
              <Ban size={18} />
              Não validar
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

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
};

const emptyUserEditor: UserEditorState = {
  email: "",
  password: "",
  role: "client",
  blocked: false,
  color: "#3b82f6",
  dispatchPriorityLevel: 0,
  dispatchBeatsEmail: "",
  dispatchAdvantageMs: 400
};

function UserEditor({
  value,
  onChange,
  onSave,
  onCancel,
  busy,
  competitors
}: {
  value: UserEditorState;
  onChange: (value: UserEditorState) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  competitors: AdminUserSummary[];
}) {
  return (
    <section className="user-editor">
      <div className="login-field">
        <Mail size={18} />
        <input
          autoComplete="off"
          placeholder="Email"
          type="email"
          value={value.email}
          onChange={(event) => onChange({ ...value, email: event.target.value })}
        />
      </div>
      <div className="login-field">
        <LockKeyhole size={18} />
        <input
          autoComplete="new-password"
          placeholder={value.originalEmail ? "Nova senha opcional" : "Senha"}
          type="password"
          value={value.password}
          onChange={(event) => onChange({ ...value, password: event.target.value })}
        />
      </div>
      <select value={value.role} onChange={(event) => onChange({ ...value, role: event.target.value === "admin" ? "admin" : "client" })}>
        <option value="client">Cliente</option>
        <option value="admin">Admin</option>
      </select>
      <label className="toggle-row">
        <input type="checkbox" checked={value.blocked} onChange={(event) => onChange({ ...value, blocked: event.target.checked })} />
        Bloqueado
      </label>
      <label className="login-field">
        <Gauge size={18} />
        <select aria-label="Este cliente ganha de" value={value.dispatchBeatsEmail || ""} onChange={(event) => onChange({ ...value, dispatchBeatsEmail: event.target.value, dispatchPriorityLevel: 0 })}>
          <option value="">Não ganha de ninguém</option>
          {competitors.filter((user) => user.role === "client" && user.email !== (value.originalEmail || value.email)).map((user) => (
            <option key={user.email} value={user.email}>Ganha de {user.email}</option>
          ))}
        </select>
      </label>
      {value.dispatchBeatsEmail ? (
        <label className="login-field">
          <Clock3 size={18} />
          <input
            aria-label="Vantagem em milissegundos"
            min={400}
            max={10000}
            step={50}
            type="number"
            value={value.dispatchAdvantageMs}
            onChange={(event) => onChange({ ...value, dispatchAdvantageMs: Math.max(400, Number(event.target.value) || 400) })}
          />
          <span>ms de vantagem (mínimo 400)</span>
        </label>
      ) : null}
      <label className="color-picker-row" title="Cor do usuário no histórico">
        <span className="color-orb" style={{ background: value.color }} />
        <input
          aria-label="Cor do usuário"
          type="color"
          value={value.color}
          onChange={(event) => onChange({ ...value, color: event.target.value })}
        />
      </label>
      <div className="user-editor-actions">
        <button className="button" type="button" onClick={onCancel}>
          <X size={18} />
          Cancelar
        </button>
        <button className="button primary" disabled={busy || !value.email.trim() || (!value.originalEmail && !value.password.trim())} type="button" onClick={onSave}>
          <Save size={18} />
          Salvar
        </button>
      </div>
    </section>
  );
}

function AdminUserRow({
  user,
  onEdit,
  onToggleBlock,
  onDetails
}: {
  user: AdminUserSummary;
  onEdit: () => void;
  onToggleBlock: () => void;
  onDetails: () => void;
}) {
  return (
    <article className={user.blocked ? "user-row blocked" : `user-row presence-${user.presenceStatus}`} style={colorStyle(user.color)}>
      <span className={user.blocked ? "user-state-icon blocked" : "user-state-icon"}>
        {user.blocked ? <Ban size={19} /> : user.panelOnline ? <Activity size={19} /> : <CheckCircle2 size={19} />}
      </span>
      <div>
        <p className="panel-label client-label">
          <span className="client-color-dot" />
          {user.role === "admin" ? "Admin" : "Cliente"} · {getPresenceCopy(user)}
        </p>
        <h2>{user.email}</h2>
        <div className="route-meta">
          <span>Último login: {formatDate(user.lastLoginAt)}</span>
          <span>{getBotOpenCopy(user)}</span>
          <span>{user.dispatchBeatsEmail ? `Ganha de: ${user.dispatchBeatsEmail} · ${user.dispatchAdvantageMs || 400}ms` : "Não ganha de ninguém"}</span>
          <span>Uso: {formatDuration(user.totalUsageMs)}</span>
          <span>{user.loginCount} login(s)</span>
        </div>
      </div>
      <div className="user-row-actions">
        <button className="icon-button" title="Mais especificações" type="button" onClick={onDetails}>
          <Info size={19} />
        </button>
        <button className="icon-button" title="Editar usuário" type="button" onClick={onEdit}>
          <Edit3 size={19} />
        </button>
        <button className={user.blocked ? "icon-button active-danger" : "icon-button"} title={user.blocked ? "Desbloquear" : "Bloquear"} type="button" onClick={onToggleBlock}>
          <Ban size={19} />
        </button>
      </div>
    </article>
  );
}

function UserDetailModal({ detail, onClose }: { detail: AdminUserDetail; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sheet-dialog user-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="user-detail-title">
        <div className="sheet-heading">
          <div>
            <p className="panel-label">Especificações</p>
            <h2 id="user-detail-title">{detail.email}</h2>
          </div>
          <button className="icon-button" title="Fechar" type="button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <section className="detail-grid">
          <AdminMetric Icon={Clock3} tone="blue" title="Uso" value={formatDuration(detail.totalUsageMs)} detail={`${detail.loginCount} login(s)`} />
          <AdminMetric Icon={Activity} tone={detail.panelOnline ? "green" : detail.presenceStatus === "recent" ? "yellow" : "blue"} title="Painel" value={getPresenceCopy(detail)} detail={getBotOpenCopy(detail)} />
          <AdminMetric Icon={Bot} tone={detail.monitoringEnabled ? "green" : "yellow"} title="Bot" value={detail.botStatus} detail={detail.monitoringEnabled ? "monitorando" : "parado"} />
          <AdminMetric Icon={Wifi} tone="blue" title="Zap" value={formatShortDate(detail.lastWhatsAppConnectionAt)} detail="última conexão" />
          <AdminMetric Icon={Route} tone="green" title="Rotas" value={detail.routes.length} detail="histórico salvo" />
          <AdminMetric Icon={Zap} tone="yellow" title="Latência" value={`${detail.performanceMetrics?.lastDispatchLatencyMs || 0}ms`} detail={`média ${detail.performanceMetrics?.averageDispatchLatencyMs || 0}ms`} />
        </section>

        <section className="detail-section">
          <p className="panel-label">Configuração do usuário</p>
          <div className="detail-list">
            <span>Nome configurado: <b>{detail.config.nomeEnvio || "Não configurado"}</b></span>
            <span>Grupo alvo: <b>{detail.config.grupoAlvoNome || detail.config.grupoAlvoJid || "Não configurado"}</b></span>
            <span>Grupo teste: <b>{detail.config.grupoTesteNome || detail.config.grupoTesteJid || "Não configurado"}</b></span>
            <span>Rotas por imagem: <b>{formatOcrRoutes(detail.config.rotasMonitoradas || [], detail.config.rotasMonitoradasDetalhadas || []).join(", ") || "Nenhuma"}</b></span>
            <span>Mensagens alvo: <b>{(detail.config.codigosMensagensAlvo || []).join(", ") || "Nenhuma"}</b></span>
            <span>Mensagens teste: <b>{(detail.config.codigosMensagensTeste || []).join(", ") || "Nenhuma"}</b></span>
          </div>
        </section>

        <section className="detail-section">
          <p className="panel-label">Histórico de login</p>
          <div className="detail-list">
            {detail.loginHistory.length ? detail.loginHistory.slice(0, 8).map((event) => (
              <span key={event.id}>{formatDate(event.timestamp)} · {event.ip || "IP não identificado"}</span>
            )) : <span>Nenhum login registrado.</span>}
          </div>
        </section>

        <section className="detail-section">
          <p className="panel-label">Logs recentes do bot</p>
          <div className="detail-list scrollable-detail-list">
            {detail.logs.length ? detail.logs.slice(0, 60).map((log) => (
              <span key={log.id}>{formatDate(log.timestamp)} · {uiText(log.message)}</span>
            )) : <span>Nenhum log registrado.</span>}
          </div>
        </section>
      </section>
    </div>
  );
}

function RouteDetailModal({ route, onClose }: { route: RouteDispatch; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sheet-dialog user-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="route-detail-title">
        <div className="sheet-heading">
          <div>
            <p className="panel-label">{getRouteTriggerLabel(route)} · {getRouteDecisionLabel(route)}</p>
            <h2 id="route-detail-title">{route.groupName || route.groupJid || "Grupo sem nome"}</h2>
          </div>
          <button className="icon-button" title="Fechar" type="button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <section className="detail-grid">
          <AdminMetric Icon={Send} tone="blue" title="Envio" value={`${route.confirmedCount}/${route.totalCount}`} detail={route.status} />
          <AdminMetric Icon={MessageSquareText} tone="yellow" title="Reações" value={route.reactions.length} detail="recebidas" />
          <AdminMetric Icon={Clock3} tone="blue" title="Criada" value={formatShortDate(route.createdAt)} detail={new Date(route.createdAt).toLocaleTimeString("pt-BR")} />
          <AdminMetric Icon={ShieldCheck} tone={getRouteDecisionStatus(route) === "validated" ? "green" : getRouteDecisionStatus(route) === "rejected" ? "red" : "yellow"} title="Decisão" value={getRouteDecisionLabel(route)} detail={route.validatedBy || route.rejectedBy || "aguardando"} />
        </section>
        <section className="detail-section">
          <p className="panel-label">Dados da rota</p>
          <div className="detail-list">
            <span>Cliente: <b>{route.clientEmail || "Não identificado"}</b></span>
            <span>Grupo: <b>{route.groupName || route.groupJid || "Não identificado"}</b></span>
            <span>Origem: <b>{getRouteTriggerLabel(route)}</b></span>
            <span>Atualizada: <b>{formatDate(route.updatedAt)}</b></span>
          </div>
        </section>
        <section className="detail-section">
          <p className="panel-label">Mensagens</p>
          <div className="detail-list">
            {route.messages.length ? route.messages.map((message, index) => <span key={`${route.id}-detail-message-${index}`}>{uiText(message)}</span>) : <span>Nenhuma mensagem registrada.</span>}
          </div>
        </section>
        <section className="detail-section">
          <p className="panel-label">Reações</p>
          <div className="detail-list">
            {route.reactions.length ? route.reactions.map((reaction) => (
              <span key={`${route.id}-detail-reaction-${reaction.id}`}>
                {reaction.emoji || "?"} · {reaction.isAdmin ? `Líder${reaction.leaderName ? ` - ${reaction.leaderName}` : ""}` : getReactionDisplayPhone(reaction)}
              </span>
            )) : <span>Nenhuma reação registrada.</span>}
          </div>
        </section>
      </section>
    </div>
  );
}

function SupportMessageRow({ message, onMarkRead }: { message: SupportMessage; onMarkRead: () => void }) {
  return (
    <article className={message.read ? "support-message-row" : "support-message-row unread"} style={colorStyle(message.clientColor)}>
      <div>
        <p className="panel-label client-label">
          <span className="client-color-dot" />
          {message.read ? "Lida" : "Nova mensagem"}
        </p>
        <h2>{message.email}</h2>
        <small>{formatDate(message.createdAt)}</small>
      </div>
      <p>{message.message}</p>
      {!message.read ? (
        <button className="button" type="button" onClick={onMarkRead}>
          Marcar como lida
        </button>
      ) : null}
    </article>
  );
}

function AdminSectionCard({
  title,
  detail,
  value,
  tone,
  Icon,
  badge,
  onOpen
}: {
  title: string;
  detail: string;
  value: string | number;
  tone: "yellow" | "green" | "blue" | "red";
  Icon: typeof Home;
  badge?: number;
  onOpen: () => void;
}) {
  return (
    <button className={`admin-section-card admin-section-card-${tone}`} type="button" onClick={onOpen}>
      {badge ? <span className="admin-section-badge">{badge}</span> : null}
      <span className="admin-section-icon">
        <Icon size={22} />
      </span>
      <span>
        <small>{title}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </button>
  );
}

function AdminSectionModal({
  title,
  eyebrow,
  onClose,
  children
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sheet-dialog admin-section-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-section-title">
        <div className="sheet-heading">
          <div>
            <p className="panel-label">{eyebrow}</p>
            <h2 id="admin-section-title">{title}</h2>
          </div>
          <button className="icon-button" title="Fechar" type="button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="admin-section-scroll">{children}</div>
      </section>
    </div>
  );
}

function AdminLogRow({ log }: { log: AdminLogEntry }) {
  return (
    <article className={`admin-log-row admin-log-${log.level}`} style={colorStyle(log.clientColor)}>
      <div>
        <p className="panel-label client-label">
          <span className="client-color-dot" />
          {log.clientEmail}
        </p>
        <small>{formatDate(log.timestamp)}</small>
      </div>
      <p>{uiText(log.message)}</p>
    </article>
  );
}

function AdminDashboard({ userEmail, onLogout }: { userEmail: string; onLogout: () => void }) {
  const [dashboard, setDashboard] = useState<AdminRoutesSnapshot>({
    routes: [],
    pendingReactionRoutes: [],
    totals: { routes: 0, validated: 0, reactions: 0, clients: 0 }
  });
  const [usersDashboard, setUsersDashboard] = useState<AdminUsersSnapshot>({ users: [] });
  const [supportDashboard, setSupportDashboard] = useState<AdminSupportMessagesSnapshot>({ messages: [], unread: 0 });
  const [adminLogs, setAdminLogs] = useState<AdminLogEntry[]>([]);
  const [activeSection, setActiveSection] = useState<AdminSection>();
  const [activeAdminTab, setActiveAdminTab] = useState<AdminMainTab>("dashboard");
  const [editor, setEditor] = useState<UserEditorState>();
  const [detail, setDetail] = useState<AdminUserDetail>();
  const [routeDetail, setRouteDetail] = useState<RouteDispatch>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastNotifiedSupportId, setLastNotifiedSupportId] = useState("");
  const [leaderAlert, setLeaderAlert] = useState("");
  const [lastLeaderReactionId, setLastLeaderReactionId] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [routeStatusFilter, setRouteStatusFilter] = useState<RouteStatusFilter>("all");
  const [routeKindFilter, setRouteKindFilter] = useState<RouteKindFilter>("all");
  const [routeHistoryTab, setRouteHistoryTab] = useState<RouteHistoryTab>("automatic");
  const [routeSearch, setRouteSearch] = useState("");
  const [adminLogLevelFilter, setAdminLogLevelFilter] = useState<AdminLogLevelFilter>("all");
  const [adminLogSearch, setAdminLogSearch] = useState("");
  const [lastSeenLogAt, setLastSeenLogAt] = useState(() => new Date().toISOString());
  const [seenAdminCounts, setSeenAdminCounts] = useState({ validations: 0, alerts: 0, clients: 0 });
  const [logToast, setLogToast] = useState<AdminLogEntry>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState<CleanupTarget>();
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [actionToast, setActionToast] = useState("");
  const [reportStartDate, setReportStartDate] = useState(getCurrentMonthStartInput);
  const [reportEndDate, setReportEndDate] = useState(() => toDateInputValue(new Date()));
  const [reportDatePreset, setReportDatePreset] = useState<"current-month" | "previous-month" | "last-30-days" | "custom" | "all">("current-month");
  const [historyDatePreset, setHistoryDatePreset] = useState<"current-month" | "previous-month" | "last-30-days" | "custom" | "all">("current-month");
  const [historyStartDate, setHistoryStartDate] = useState(getCurrentMonthStartInput);
  const [historyEndDate, setHistoryEndDate] = useState(() => toDateInputValue(new Date()));

  function applyHistoryDatePreset(preset: "current-month" | "previous-month" | "last-30-days" | "all") {
    const range = getAdminDatePreset(preset);
    setHistoryDatePreset(preset);
    setHistoryStartDate(range.startDate);
    setHistoryEndDate(range.endDate);
  }

  function applyReportDatePreset(preset: "current-month" | "previous-month" | "last-30-days" | "all") {
    const range = getAdminDatePreset(preset);
    setReportDatePreset(preset);
    setReportStartDate(range.startDate);
    setReportEndDate(range.endDate);
  }

  useEdgeSwipeBack(() => {
    if (leaderAlert) return setLeaderAlert("");
    if (routeDetail) return setRouteDetail(undefined);
    if (detail) return setDetail(undefined);
    if (editor) return setEditor(undefined);
    if (activeSection) {
      setActiveSection(undefined);
      setConfirmLogout(false);
      setConfirmCleanup(undefined);
      return;
    }
    if (notificationsOpen) return setNotificationsOpen(false);
    if (activeAdminTab !== "dashboard") setActiveAdminTab("dashboard");
  });

  const clientOptions = useMemo(
    () => usersDashboard.users.filter((user) => user.role === "client"),
    [usersDashboard.users]
  );
  const filteredRoutes = useMemo(() => {
    return dashboard.routes.filter((route) => {
      const matchesClient = clientFilter === "all" || route.clientEmail === clientFilter;
      const matchesDate = isDateInsideAdminRange(route.createdAt || route.updatedAt, historyStartDate, historyEndDate);
      const search = routeSearch.trim().toLowerCase();
      const matchesSearch =
        !search ||
        [
          route.groupName,
          route.groupJid,
          route.clientEmail,
          route.validatedBy,
          ...route.messages,
          ...route.reactions.flatMap((reaction) => [reaction.senderPhone, reaction.leaderName || "", ...(reaction.senderIdentifiers || [])])
        ].some((item) => String(item || "").toLowerCase().includes(search));
      const hasLeaderReaction = route.reactions.some((reaction) => reaction.isAdmin);
      const trigger = getRouteTrigger(route);
      const matchesStatus =
        routeStatusFilter === "all" ||
        (routeStatusFilter === "pending" && getRouteDecisionStatus(route) === "pending") ||
        (routeStatusFilter === "validated" && getRouteDecisionStatus(route) === "validated") ||
        (routeStatusFilter === "rejected" && getRouteDecisionStatus(route) === "rejected") ||
        (routeStatusFilter === "leader" && hasLeaderReaction);
      const matchesKind =
        routeKindFilter === "all" ||
        (routeKindFilter === "automatic" && route.mode === "target" && trigger === "automatic") ||
        (routeKindFilter === "manual" && ["manual", "simulation"].includes(trigger)) ||
        (routeKindFilter === "test" && (route.mode === "test" || ["warmup", "target-simulation"].includes(trigger)));
      return matchesClient && matchesDate && matchesSearch && matchesStatus && matchesKind;
    });
  }, [clientFilter, dashboard.routes, historyEndDate, historyStartDate, routeKindFilter, routeSearch, routeStatusFilter]);
  const filteredPendingRoutes = useMemo(
    () => dashboard.pendingReactionRoutes.filter((route) => getRouteDecisionStatus(route) === "pending" && (clientFilter === "all" || route.clientEmail === clientFilter)),
    [clientFilter, dashboard.pendingReactionRoutes]
  );
  const filteredLogs = useMemo(() => {
    const search = adminLogSearch.trim().toLowerCase();
    return adminLogs.filter((log) => {
      const matchesClient = clientFilter === "all" || log.clientEmail === clientFilter;
      const matchesLevel = adminLogLevelFilter === "all" || log.level === adminLogLevelFilter;
      const matchesSearch =
        !search ||
        [log.clientEmail, log.level, log.message, log.timestamp].some((item) => String(item || "").toLowerCase().includes(search));
      return matchesClient && matchesLevel && matchesSearch;
    });
  }, [adminLogLevelFilter, adminLogSearch, adminLogs, clientFilter]);
  const filteredSupportMessages = useMemo(
    () => supportDashboard.messages.filter((message) => clientFilter === "all" || message.email === clientFilter),
    [clientFilter, supportDashboard.messages]
  );
  const unreadLogCount = adminLogs.filter((log) => new Date(log.timestamp).getTime() > new Date(lastSeenLogAt).getTime()).length;

  function showAdminToast(message: string) {
    setActionToast(message);
    window.setTimeout(() => setActionToast(""), 1000);
  }

  function applyMonitorSnapshot(snapshot: Awaited<ReturnType<typeof getAdminMonitor>>) {
    const safeUsers = snapshot?.users && Array.isArray(snapshot.users.users) ? snapshot.users : undefined;
    const safeRoutes = snapshot?.routes && Array.isArray(snapshot.routes.routes) ? snapshot.routes : undefined;
    const safeLogs = Array.isArray(snapshot?.logs) ? snapshot.logs : [];
    if (safeRoutes) setDashboard(safeRoutes);
    if (safeUsers) setUsersDashboard(safeUsers);
    if (snapshot?.support && Array.isArray(snapshot.support.messages)) setSupportDashboard(snapshot.support);
    setAdminLogs(safeLogs);
    setDetail((current) => {
      if (!current || !safeUsers || !safeRoutes) return current;
      const summary = safeUsers.users.find((user) => user.email === current.email);
      return {
        ...current,
        ...(summary || {}),
        logs: safeLogs.filter((log) => log.clientEmail === current.email).slice(0, 250),
        routes: safeRoutes.routes.filter((route) => route.clientEmail === current.email)
      };
    });
    if (safeUsers && safeRoutes) setError("");
  }

  function refresh() {
    getAdminMonitor()
      .then(applyMonitorSnapshot)
      .catch((nextError) => {
        if (isAuthError(nextError)) {
          onLogout();
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "Falha ao carregar monitoramento.");
      });
  }

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeAdminMonitor(applyMonitorSnapshot, refresh);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const locked = Boolean(activeSection || detail || routeDetail || leaderAlert);
    if (!locked) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [activeSection, detail, routeDetail, leaderAlert]);

  useEffect(() => {
    if (activeSection !== "logs" && activeAdminTab !== "logs") return;
    const newestLog = adminLogs[0];
    if (newestLog) setLastSeenLogAt(newestLog.timestamp);
    setLogToast(undefined);
  }, [activeAdminTab, activeSection, adminLogs]);

  useEffect(() => {
    if (activeSection === "logs" || activeAdminTab === "logs") return;
    const newestLog = adminLogs[0];
    if (!newestLog) return;
    if (new Date(newestLog.timestamp).getTime() <= new Date(lastSeenLogAt).getTime()) return;
    setLogToast(newestLog);
    const timer = window.setTimeout(() => setLogToast(undefined), 5200);
    return () => window.clearTimeout(timer);
  }, [activeAdminTab, activeSection, adminLogs, lastSeenLogAt]);

  useEffect(() => {
    const latestUnread = supportDashboard.messages.find((message) => !message.read);
    if (!latestUnread || latestUnread.id === lastNotifiedSupportId) return;
    setLastNotifiedSupportId(latestUnread.id);

    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audio = new AudioContextClass();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.1, audio.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.28);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.3);
        window.setTimeout(() => void audio.close(), 360);
      }

      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Nova mensagem no painel", {
          body: `${latestUnread.email}: ${latestUnread.message.slice(0, 90)}`
        });
      }
    } catch {
      // O navegador pode bloquear áudio/notificações antes de interação do admin.
    }
  }, [lastNotifiedSupportId, supportDashboard.messages]);

  useEffect(() => {
    const reaction = dashboard.pendingReactionRoutes
      .flatMap((route) => route.reactions)
      .filter((item) => item.isAdmin)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    if (!reaction || reaction.id === lastLeaderReactionId) return;
    setLastLeaderReactionId(reaction.id);
    setLeaderAlert(`Reação do líder${reaction.leaderName ? ` (${reaction.leaderName})` : ""} foi encontrada.`);

    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audio = new AudioContextClass();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = 1046;
        gain.gain.setValueAtTime(0.0001, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.38);
        window.setTimeout(() => void audio.close(), 450);
      }
    } catch {
      // O navegador pode bloquear áudio antes da interação do admin.
    }
  }, [dashboard.pendingReactionRoutes, lastLeaderReactionId]);

  async function saveUser(nextEditor = editor) {
    if (!nextEditor) return;
    setBusy(true);
    try {
      const nextUsers = await saveAdminUser(nextEditor);
      setUsersDashboard(nextUsers);
      setEditor(undefined);
      setError("");
      showAdminToast("Usuário salvo.");
    } catch (nextError) {
      if (isAuthError(nextError)) {
        onLogout();
        return;
      }
      setError(nextError instanceof Error ? nextError.message : "Não consegui salvar usuário.");
    } finally {
      setBusy(false);
    }
  }

  async function openDetails(email: string) {
    try {
      setDetail(await getAdminUserDetail(email));
      setError("");
    } catch (nextError) {
      if (isAuthError(nextError)) {
        onLogout();
        return;
      }
      setError(nextError instanceof Error ? nextError.message : "Não consegui abrir especificações.");
    }
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setError("Este navegador não suporta notificações.");
      return;
    }
    const permission = await Notification.requestPermission();
    setError(permission === "granted" ? "" : "Permissão de notificação não liberada no navegador.");
  }

  async function readSupportMessage(id: string) {
    try {
      setSupportDashboard(await markSupportMessageRead(id));
      showAdminToast("Notificação marcada como lida.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui marcar a mensagem.");
    }
  }

  async function validateRoute(routeId: string) {
    try {
      setDashboard(await validateAdminRoute(routeId));
      setError("");
      showAdminToast("Rota validada.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui validar a rota.");
    }
  }

  async function rejectRoute(routeId: string) {
    try {
      setDashboard(await rejectAdminRoute(routeId));
      setError("");
      showAdminToast("Rota marcada como não válida.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Não consegui rejeitar a rota.");
    }
  }

  function filterRouteClient(email: string) {
    if (!email) return;
    setClientFilter(email);
    setActiveAdminTab("history");
  }

  async function runCleanup(target: CleanupTarget) {
    if (confirmCleanup !== target) {
      setConfirmCleanup(target);
      return;
    }

    setCleanupBusy(true);
    try {
      const snapshot = await clearAdminMaintenance({
        target,
        clientEmail: clientFilter === "all" ? undefined : clientFilter
      });
      applyMonitorSnapshot(snapshot);
      setConfirmCleanup(undefined);
      setError("");
      showAdminToast("Limpeza concluída.");
    } catch (nextError) {
      if (isAuthError(nextError)) {
        onLogout();
        return;
      }
      setError(nextError instanceof Error ? nextError.message : "Não consegui apagar os dados.");
    } finally {
      setCleanupBusy(false);
    }
  }

  const activeClientLabel = clientFilter === "all" ? "Todos os clientes" : clientFilter;
  const filteredUnreadSupport = filteredSupportMessages.filter((message) => !message.read).length;
  const onlineClients = usersDashboard.users.filter((user) => user.role === "client" && user.presenceStatus === "online").length;
  const visibleUserMetrics = usersDashboard.users
    .filter((user) => clientFilter === "all" || user.email === clientFilter)
    .map((user) => user.performanceMetrics)
    .filter((metrics): metrics is NonNullable<AdminUserSummary["performanceMetrics"]> => Boolean(metrics?.dispatchCount));
  const averageDispatchLatency = visibleUserMetrics.length
    ? Math.round(visibleUserMetrics.reduce((total, metrics) => total + metrics.averageDispatchLatencyMs, 0) / visibleUserMetrics.length)
    : 0;
  const lastDispatchLatency = visibleUserMetrics.reduce((latest, metrics) => Math.max(latest, metrics.lastDispatchLatencyMs || 0), 0);
  const automaticRoutes = filteredRoutes.filter((route) => route.mode === "target" && getRouteTrigger(route) === "automatic");
  const manualRoutes = filteredRoutes.filter((route) => ["manual", "simulation"].includes(getRouteTrigger(route)));
  const testRoutes = filteredRoutes.filter((route) => route.mode === "test" || ["warmup", "target-simulation"].includes(getRouteTrigger(route)));
  const latestTestRoute = testRoutes[0];
  const validatedRoutes = filteredRoutes.filter((route) => getRouteDecisionStatus(route) === "validated");
  const rejectedRoutes = filteredRoutes.filter((route) => getRouteDecisionStatus(route) === "rejected");
  const liveActivity = [
    ...filteredLogs.slice(0, 6).map((log) => ({
      id: `log-${log.clientEmail}-${log.id}`,
      time: log.timestamp,
      title: log.message,
      detail: log.clientEmail,
      tone: log.level === "error" ? "red" : log.level === "success" ? "green" : "blue"
    })),
    ...filteredRoutes.slice(0, 4).map((route) => ({
      id: `route-${route.id}`,
      time: route.updatedAt,
      title: `${getRouteTriggerLabel(route)} · ${route.confirmedCount}/${route.totalCount} enviada(s)`,
      detail: `${route.groupName || route.groupJid} · ${route.clientEmail}`,
      tone: route.mode === "test" ? "purple" : "yellow"
    }))
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8);
  const alerts = [
    ...filteredPendingRoutes.map((route) => ({
      id: `pending-${route.id}`,
      title: "Validação pendente",
      detail: `${route.groupName || route.groupJid} · ${route.reactions.length} reação(ões)`,
      time: route.updatedAt,
      tone: "red" as const
    })),
    ...filteredSupportMessages.filter((message) => !message.read).map((message) => ({
      id: `support-${message.id}`,
      title: "Mensagem de suporte",
      detail: `${message.email}: ${message.message}`,
      time: message.createdAt,
      tone: "yellow" as const
    })),
    ...filteredLogs.filter((log) => log.level === "error").slice(0, 8).map((log) => ({
      id: `error-${log.clientEmail}-${log.id}`,
      title: "Erro no bot",
      detail: uiText(`${log.clientEmail}: ${log.message}`),
      time: log.timestamp,
      tone: "red" as const
    }))
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

  useEffect(() => {
    if (activeAdminTab === "validations") {
      setSeenAdminCounts((current) => ({ ...current, validations: filteredPendingRoutes.length }));
    }
    if (notificationsOpen) {
      setSeenAdminCounts((current) => ({ ...current, alerts: alerts.length }));
    }
    if (activeAdminTab === "clients") {
      setSeenAdminCounts((current) => ({ ...current, clients: onlineClients }));
    }
  }, [activeAdminTab, notificationsOpen, filteredPendingRoutes.length, alerts.length, onlineClients]);

  const reportPeriodLabel = reportDatePreset === "all" ? "Todo o histórico" : formatReportDateRange(reportStartDate, reportEndDate);
  const monthlyReport = useMemo(() => {
    const { startMs, endMs } = parseDateRange(reportStartDate, reportEndDate);
    return clientOptions.map((user) => {
      const routes = dashboard.routes.filter((route) => {
        const created = new Date(route.createdAt);
        const createdMs = created.getTime();
        return route.clientEmail === user.email && createdMs >= startMs && createdMs <= endMs;
      });
      const valid = routes.filter((route) => getRouteDecisionStatus(route) === "validated").length;
      const rejected = routes.filter((route) => getRouteDecisionStatus(route) === "rejected").length;
      const pending = routes.filter((route) => getRouteDecisionStatus(route) === "pending").length;
      const sent = routes.filter((route) => route.confirmedCount > 0).length;
      const activeDays = new Set(routes.map((route) => new Date(route.createdAt).toISOString().slice(0, 10))).size;
      const successRate = routes.length ? Math.round((valid / routes.length) * 100) : 0;
      const pickupRate = routes.length ? Math.round((sent / routes.length) * 100) : 0;
      const lastRoute = [...routes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      const messageCounts = new Map<string, number>();
      routes.forEach((route) => {
        const label = route.ocr?.bairro || route.ocr?.route || route.messages[0] || "Sem mensagem";
        messageCounts.set(label, (messageCounts.get(label) || 0) + 1);
      });
      const topRoutes = Array.from(messageCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, count]) => `${label} (${count})`);
      return { user, routes, valid, rejected, pending, sent, activeDays, successRate, pickupRate, lastRoute, topRoutes };
    }).sort((a, b) => b.valid - a.valid || b.sent - a.sent || b.routes.length - a.routes.length);
  }, [clientOptions, dashboard.routes, reportEndDate, reportStartDate]);

  const adminTabs: Array<{ id: AdminMainTab; label: string; Icon: typeof Home; badge?: number }> = [
    { id: "dashboard", label: "Dashboard", Icon: Home },
    { id: "validations", label: "Validações", Icon: ShieldCheck, badge: activeAdminTab === "validations" ? 0 : Math.max(0, filteredPendingRoutes.length - seenAdminCounts.validations) },
    { id: "history", label: "Histórico", Icon: Clock3 },
    { id: "logs", label: "Logs", Icon: Activity, badge: activeAdminTab === "logs" ? 0 : unreadLogCount },
    { id: "reports", label: "Relatório", Icon: Gauge },
    { id: "clients", label: "Clientes", Icon: UserPlus, badge: activeAdminTab === "clients" ? 0 : Math.max(0, onlineClients - seenAdminCounts.clients) },
    { id: "settings", label: "Config", Icon: Settings }
  ];

  return (
    <main className="app-shell admin-shell admin-mobile-shell">
      <ParticleBackdrop />
      <ElectricCracks />
      <ForegroundSparks />
      <div className="bot-ambient" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <section className="admin-mobile-header">
        <span className="admin-app-icon">{activeAdminTab === "validations" ? <ShieldCheck size={25} /> : <Activity size={24} />}</span>
        <div>
          <h1>{activeAdminTab === "validations" ? "Validações e histórico" : activeAdminTab === "history" ? "Histórico permanente" : activeAdminTab === "logs" ? "Logs ao vivo" : activeAdminTab === "reports" ? "Relatório mensal" : activeAdminTab === "clients" ? "Clientes" : activeAdminTab === "settings" ? "Configurações" : "Central de comando"}</h1>
          <p>
            {activeAdminTab === "dashboard" ? "Dados ao vivo de todos os clientes" : activeAdminTab === "validations" ? "Monitore, valide e audite todas as rotas do bot" : activeClientLabel}
            {activeAdminTab === "dashboard" ? <span className="online-copy">Tudo online</span> : null}
          </p>
        </div>
        <button className="icon-button alert-button" title="Notificações" type="button" onClick={() => setNotificationsOpen((current) => !current)}>
          {Math.max(0, alerts.length - seenAdminCounts.alerts) ? <b>{Math.max(0, alerts.length - seenAdminCounts.alerts)}</b> : null}
          <Bell size={20} />
        </button>
        <button className="button admin-filter-button" title="Configurações" type="button" onClick={() => setActiveAdminTab("settings")}>
          <Settings size={18} />
          Config
        </button>
        {notificationsOpen ? (
          <section className="notification-popover">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Notificações</p>
                <h2>{alerts.length} recentes</h2>
              </div>
              <button className="icon-button" title="Fechar" type="button" onClick={() => setNotificationsOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="alert-list compact">
              {alerts.length ? alerts.slice(0, 8).map((alert) => (
                <article className={`alert-row tone-${alert.tone}`} key={`bell-${alert.id}`}>
                  <AlertTriangle size={17} />
                  <div>
                    <strong>{alert.title}</strong>
                    <p>{alert.detail}</p>
                  </div>
                  <time>{formatShortDate(alert.time)}</time>
                </article>
              )) : <p className="qr-empty">Nenhuma notificação.</p>}
            </div>
          </section>
        ) : null}
      </section>

      <section className="admin-mobile-filters">
        <label>
          <span>Cliente</span>
          <select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)}>
            <option value="all">Todos os clientes</option>
            {clientOptions.map((user) => (
              <option key={user.email} value={user.email}>{user.email}</option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={refresh}>
          <RefreshCw size={18} />
          Atualizar
        </button>
      </section>

      {activeAdminTab === "dashboard" ? (
        <section className="admin-tab-page">
          <section className="command-metrics-grid">
            <AdminMetric Icon={UserPlus} tone="green" title="Clientes online" value={onlineClients} detail="agora" />
            <AdminMetric Icon={Send} tone="yellow" title="Disparos hoje" value={filteredRoutes.length} detail={`${validatedRoutes.length} validadas`} />
            <AdminMetric Icon={MessageSquareText} tone="blue" title="Reações" value={filteredRoutes.reduce((total, route) => total + route.reactions.length, 0)} detail="recebidas" />
            <AdminMetric Icon={Activity} tone="blue" title="Logs ao vivo" value={filteredLogs.length} detail="agora" />
            <AdminMetric Icon={Route} tone="green" title="Grupos ativos" value={new Set(filteredRoutes.map((route) => route.groupJid).filter(Boolean)).size} detail="estáveis" />
            <AdminMetric Icon={Zap} tone="yellow" title="Latência média" value={averageDispatchLatency ? `${averageDispatchLatency}ms` : "0ms"} detail={lastDispatchLatency ? `último ${lastDispatchLatency}ms` : "sem disparos"} />
          </section>

          <article className="command-card queue-card">
            <span className="command-card-icon"><Send size={22} /></span>
            <div>
              <h2>Fila de envio</h2>
              <p>{filteredRoutes.filter((route) => route.status === "sending").length} mensagens aguardando</p>
              <div className="queue-progress" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(8, filteredRoutes.filter((route) => route.status === "sending").length * 22))}%` }} />
              </div>
            </div>
            <button className="button" type="button" onClick={() => setActiveAdminTab("history")}>Ver fila</button>
          </article>

          <article className="command-card validation-card">
            <span className="command-card-icon danger"><AlertTriangle size={22} /></span>
            <div>
              <h2>Validações pendentes</h2>
              <p>Fila aberta · aguardando validação manual</p>
              <div className="validation-mini-row">
                <span>Na fila <b>{filteredPendingRoutes.length}</b></span>
                <span>Aguardando líder <b>{filteredPendingRoutes.filter((route) => route.reactions.some((reaction) => reaction.isAdmin)).length}</b></span>
                <span>Prontas <b>{filteredPendingRoutes.filter((route) => route.reactions.length).length}</b></span>
              </div>
            </div>
            <strong>{filteredPendingRoutes.length}</strong>
            <button className="button" type="button" onClick={() => setActiveAdminTab("validations")}>Abrir fila</button>
          </article>

          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Atividade ao vivo</p>
                <h2>Últimos eventos</h2>
              </div>
              <button className="button" type="button" onClick={() => setNotificationsOpen(true)}>Ver tudo</button>
            </div>
            <div className="live-activity-list">
              {liveActivity.length ? liveActivity.map((item) => (
                <div className={`live-activity-row tone-${item.tone}`} key={item.id}>
                  <span />
                  <time>{new Date(item.time).toLocaleTimeString("pt-BR")}</time>
                  <p>{item.title}</p>
                  <small>{item.detail}</small>
                </div>
              )) : <p className="qr-empty">Nenhuma atividade ainda.</p>}
            </div>
          </article>

          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Histórico por origem</p>
                <h2>Resumo</h2>
              </div>
              <button className="button" type="button" onClick={() => setActiveAdminTab("history")}>Ver tudo</button>
            </div>
            <div className="origin-summary-grid">
              <button type="button" onClick={() => { setRouteKindFilter("automatic"); setActiveAdminTab("history"); }}>
                <Zap size={22} />
                <strong>{automaticRoutes.length}</strong>
                <span>Automático</span>
                <small>Abertura real do grupo alvo</small>
              </button>
              <button type="button" onClick={() => { setRouteKindFilter("manual"); setActiveAdminTab("history"); }}>
                <Send size={22} />
                <strong>{manualRoutes.length}</strong>
                <span>Manual / Simulação</span>
                <small>Clique manual e simulação</small>
              </button>
              <button type="button" onClick={() => { setRouteKindFilter("test"); setActiveAdminTab("history"); }}>
                <TestTube2 size={22} />
                <strong>{testRoutes.length}</strong>
                <span>Teste / mensagens</span>
                <small>Aquecimento e simulação alvo</small>
              </button>
            </div>
          </article>

          <article className="command-card test-monitor-card">
            <span className="command-card-icon purple"><TestTube2 size={22} /></span>
            <div>
              <h2>Grupo de teste</h2>
              <p>{latestTestRoute?.groupName || "Sem teste recente"}</p>
              <small>{latestTestRoute ? `${latestTestRoute.clientEmail} · ${latestTestRoute.confirmedCount}/${latestTestRoute.totalCount} mensagens` : "Apenas monitoramento no admin"}</small>
            </div>
            <button className="button" type="button" onClick={() => { setRouteKindFilter("test"); setActiveAdminTab("history"); }}>Ver detalhes</button>
          </article>

          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Alertas e notificações</p>
                <h2>Recentes</h2>
              </div>
              <button className="button" type="button" onClick={() => setNotificationsOpen(true)}>Ver todas</button>
            </div>
            <div className="alert-list compact">
              {alerts.slice(0, 3).length ? alerts.slice(0, 3).map((alert) => (
                <article className={`alert-row tone-${alert.tone}`} key={`dash-${alert.id}`}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{alert.title}</strong>
                    <p>{alert.detail}</p>
                  </div>
                  <time>{formatShortDate(alert.time)}</time>
                </article>
              )) : (
                <article className="alert-row tone-info">
                  <Info size={18} />
                  <div>
                    <strong>O bot está online no momento</strong>
                    <p>Aguardando novos eventos de clientes.</p>
                  </div>
                  <time>agora</time>
                </article>
              )}
            </div>
          </article>
        </section>
      ) : null}

      {activeAdminTab === "validations" ? (
        <section className="admin-tab-page">
          <div className="admin-subtabs">
            <button className={routeStatusFilter === "pending" ? "active" : ""} type="button" onClick={() => setRouteStatusFilter("pending")}>Pendentes <b>{filteredPendingRoutes.length}</b></button>
            <button className={routeStatusFilter === "validated" ? "active" : ""} type="button" onClick={() => setRouteStatusFilter("validated")}>Validadas <b>{validatedRoutes.length}</b></button>
            <button className={routeStatusFilter === "rejected" ? "active" : ""} type="button" onClick={() => setRouteStatusFilter("rejected")}>Não válidas <b>{rejectedRoutes.length}</b></button>
            <button className={routeStatusFilter === "all" ? "active" : ""} type="button" onClick={() => setRouteStatusFilter("all")}>Histórico</button>
          </div>
          <section className="command-metrics-grid compact">
            <AdminMetric Icon={AlertTriangle} tone="red" title="Pendentes" value={filteredPendingRoutes.length} detail="para validar" />
            <AdminMetric Icon={CheckCircle2} tone="green" title="Validadas" value={validatedRoutes.length} detail="no período" />
            <AdminMetric Icon={MessageSquareText} tone="yellow" title="Reações" value={filteredRoutes.reduce((total, route) => total + route.reactions.length, 0)} detail="recebidas" />
            <AdminMetric Icon={UserPlus} tone="blue" title="Clientes online" value={onlineClients} detail="no momento" />
          </section>
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Fila de validação</p>
                <h2>{filteredPendingRoutes.length} pendente(s)</h2>
              </div>
              <button className="button accent" type="button" onClick={() => filteredPendingRoutes.forEach((route) => void validateRoute(route.id))}>Validar todas</button>
            </div>
            <div className="validation-list">
              {filteredPendingRoutes.length ? filteredPendingRoutes.map((route) => (
                <RouteRow
                  key={`mobile-pending-${route.id}`}
                  route={route}
                  onValidate={() => validateRoute(route.id)}
                  onReject={() => rejectRoute(route.id)}
                  onFilterClient={() => filterRouteClient(route.clientEmail)}
                  onDetails={() => setRouteDetail(route)}
                />
              )) : <p className="qr-empty">Nenhuma validação pendente.</p>}
            </div>
          </article>
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Validadas recentemente</p>
                <h2>Auditoria</h2>
              </div>
            </div>
            <div className="validation-list">
              {validatedRoutes.slice(0, 8).map((route) => (
                <RouteRow
                  key={`mobile-validated-${route.id}`}
                  route={route}
                  onFilterClient={() => filterRouteClient(route.clientEmail)}
                  onDetails={() => setRouteDetail(route)}
                />
              ))}
            </div>
          </article>
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Não válidas</p>
                <h2>{rejectedRoutes.length} rejeitada(s)</h2>
              </div>
            </div>
            <div className="validation-list">
              {rejectedRoutes.slice(0, 8).map((route) => (
                <RouteRow
                  key={`mobile-rejected-${route.id}`}
                  route={route}
                  onValidate={() => validateRoute(route.id)}
                  onFilterClient={() => filterRouteClient(route.clientEmail)}
                  onDetails={() => setRouteDetail(route)}
                />
              ))}
            </div>
          </article>
        </section>
      ) : null}

      {activeAdminTab === "history" ? (
        <section className="admin-tab-page">
          <section className="history-filter-bar">
            <label className="history-search">
              <Search size={18} />
              <input
                value={routeSearch}
                onChange={(event) => setRouteSearch(event.target.value)}
                placeholder="Buscar por grupo, cliente ou e-mail..."
              />
            </label>
            <div className="admin-date-filter">
              <div className="admin-date-presets" role="group" aria-label="Período do histórico">
                <button className={historyDatePreset === "current-month" ? "active" : ""} type="button" onClick={() => applyHistoryDatePreset("current-month")}>Este mês</button>
                <button className={historyDatePreset === "previous-month" ? "active" : ""} type="button" onClick={() => applyHistoryDatePreset("previous-month")}>Mês passado</button>
                <button className={historyDatePreset === "last-30-days" ? "active" : ""} type="button" onClick={() => applyHistoryDatePreset("last-30-days")}>30 dias</button>
                <button className={historyDatePreset === "all" ? "active" : ""} type="button" onClick={() => applyHistoryDatePreset("all")}>Tudo</button>
              </div>
              <label title="Data inicial">
                <CalendarDays size={17} />
                <input aria-label="Data inicial do histórico" type="date" value={historyStartDate} onChange={(event) => { setHistoryDatePreset("custom"); setHistoryStartDate(event.target.value); }} />
              </label>
              <label title="Data final">
                <CalendarDays size={17} />
                <input aria-label="Data final do histórico" type="date" value={historyEndDate} onChange={(event) => { setHistoryDatePreset("custom"); setHistoryEndDate(event.target.value); }} />
              </label>
              <span className="admin-date-summary">{historyDatePreset === "all" ? "Todo o histórico preservado" : formatReportDateRange(historyStartDate, historyEndDate)}</span>
            </div>
            <label>
              <select value={routeStatusFilter} onChange={(event) => setRouteStatusFilter(event.target.value as RouteStatusFilter)}>
                <option value="all">Todos</option>
                <option value="pending">Pendentes</option>
                <option value="validated">Validadas</option>
                <option value="rejected">Não válidas</option>
                <option value="leader">Com líder</option>
              </select>
            </label>
            <label>
              <select value={routeKindFilter} onChange={(event) => setRouteKindFilter(event.target.value as RouteKindFilter)}>
                <option value="all">Origem</option>
                <option value="automatic">Automático</option>
                <option value="manual">Manual / simulação</option>
                <option value="test">Teste</option>
              </select>
            </label>
          </section>
          <AdminRouteHistory
            automaticRoutes={automaticRoutes}
            manualRoutes={manualRoutes}
            testRoutes={testRoutes}
            activeTab={routeHistoryTab}
            onTabChange={setRouteHistoryTab}
            onValidate={validateRoute}
            onReject={rejectRoute}
            onFilterClient={filterRouteClient}
            onDetails={setRouteDetail}
          />
        </section>
      ) : null}

      {activeAdminTab === "logs" ? (
        <section className="admin-tab-page">
          <section className="history-filter-bar">
            <label className="history-search">
              <Search size={18} />
              <input
                value={adminLogSearch}
                onChange={(event) => setAdminLogSearch(event.target.value)}
                placeholder="Buscar log, cliente, erro, imagem..."
              />
            </label>
            <label>
              <select value={adminLogLevelFilter} onChange={(event) => setAdminLogLevelFilter(event.target.value as AdminLogLevelFilter)}>
                <option value="all">Todos os níveis</option>
                <option value="success">Sucesso</option>
                <option value="info">Info</option>
                <option value="warning">Avisos</option>
                <option value="error">Erros</option>
              </select>
            </label>
            <button className="button" type="button" onClick={() => { setAdminLogSearch(""); setAdminLogLevelFilter("all"); }}>
              Limpar filtro
            </button>
          </section>

          <section className="command-metrics-grid compact">
            <AdminMetric Icon={Activity} tone="blue" title="Logs visíveis" value={filteredLogs.length} detail={activeClientLabel} />
            <AdminMetric Icon={CheckCircle2} tone="green" title="Sucessos" value={filteredLogs.filter((log) => log.level === "success").length} detail="eventos ok" />
            <AdminMetric Icon={AlertTriangle} tone="yellow" title="Avisos" value={filteredLogs.filter((log) => log.level === "warning").length} detail="atenção" />
            <AdminMetric Icon={Ban} tone="red" title="Erros" value={filteredLogs.filter((log) => log.level === "error").length} detail="falhas" />
          </section>

          <article className="command-panel admin-live-log-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Tempo real por cliente</p>
                <h2>{filteredLogs.length} evento(s)</h2>
              </div>
              <button className="button" type="button" onClick={refresh}>
                <RefreshCw size={18} />
                Atualizar
              </button>
            </div>
            <div className="admin-log-list full">
              {filteredLogs.length ? filteredLogs.map((log) => (
                <AdminLogRow key={`tab-${log.clientEmail}-${log.id}`} log={log} />
              )) : <p className="qr-empty">Nenhum log encontrado com os filtros atuais.</p>}
            </div>
          </article>
        </section>
      ) : null}

      {activeAdminTab === "reports" ? (
        <section className="admin-tab-page">
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Relatório</p>
                <h2>{reportPeriodLabel}</h2>
              </div>
              <button className="button" type="button" onClick={() => { setClientFilter("all"); setRouteStatusFilter("validated"); setActiveAdminTab("history"); }}>Abrir validadas</button>
            </div>
            <div className="report-date-filter">
              <div className="report-date-presets" role="group" aria-label="Período do relatório">
                <button className={reportDatePreset === "current-month" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("current-month")}>Este mês</button>
                <button className={reportDatePreset === "previous-month" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("previous-month")}>Mês passado</button>
                <button className={reportDatePreset === "last-30-days" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("last-30-days")}>30 dias</button>
                <button className={reportDatePreset === "all" ? "active" : ""} type="button" onClick={() => applyReportDatePreset("all")}>Tudo</button>
              </div>
              <label>
                <CalendarDays size={18} />
                <span>Data inicial</span>
                <input type="date" value={reportStartDate} onChange={(event) => { setReportDatePreset("custom"); setReportStartDate(event.target.value); }} />
              </label>
              <label>
                <CalendarDays size={18} />
                <span>Data final</span>
                <input type="date" value={reportEndDate} onChange={(event) => { setReportDatePreset("custom"); setReportEndDate(event.target.value); }} />
              </label>
              <span className="admin-date-summary">{reportDatePreset === "all" ? "Todo o relatório preservado" : reportPeriodLabel}</span>
            </div>
            <div className="report-list">
              {monthlyReport.length ? monthlyReport.map((item) => (
                <article className="report-row" key={`report-${item.user.email}`} style={colorStyle(item.user.color)}>
                  <div className="report-client">
                    <span className="client-color-dot" />
                    <div>
                      <strong>{item.user.email}</strong>
                      <p>{item.routes.length} rota(s) no período</p>
                    </div>
                  </div>
                  <div className="report-stats">
                    <span className="report-stat ok"><small>Válidas</small><b>{item.valid}</b></span>
                    <span className="report-stat warn"><small>Pendentes</small><b>{item.pending}</b></span>
                    <span className="report-stat danger"><small>Não válidas</small><b>{item.rejected}</b></span>
                    <span className="report-stat"><small>Pegas</small><b>{item.sent}</b></span>
                    <span className="report-stat ok"><small>Aproveit.</small><b>{item.successRate}%</b></span>
                    <span className="report-stat"><small>Dias</small><b>{item.activeDays}</b></span>
                  </div>
                  <div className="report-route-summary">
                    <span>Última: {item.lastRoute ? formatShortDate(item.lastRoute.createdAt) : "sem rota"}</span>
                    <span>{item.topRoutes.length ? `Mais recorrentes: ${item.topRoutes.join(" | ")}` : "Sem recorrência no período"}</span>
                    <span>Taxa de envio: {item.pickupRate}%</span>
                  </div>
                  <button className="button" type="button" onClick={() => { setClientFilter(item.user.email); setRouteStatusFilter("validated"); setActiveAdminTab("history"); }}>Ver</button>
                </article>
              )) : <p className="qr-empty">Nenhum cliente no relatório.</p>}
            </div>
          </article>
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Resumo geral</p>
                <h2>{monthlyReport.reduce((total, item) => total + item.valid, 0)} rotas válidas</h2>
              </div>
            </div>
            <section className="command-metrics-grid compact">
              <AdminMetric Icon={CheckCircle2} tone="green" title="Válidas" value={monthlyReport.reduce((total, item) => total + item.valid, 0)} detail="no mês" />
              <AdminMetric Icon={Clock3} tone="yellow" title="Pendentes" value={monthlyReport.reduce((total, item) => total + item.pending, 0)} detail="aguardando" />
              <AdminMetric Icon={Ban} tone="red" title="Não válidas" value={monthlyReport.reduce((total, item) => total + item.rejected, 0)} detail="julgadas" />
              <AdminMetric Icon={Send} tone="blue" title="Pegas" value={monthlyReport.reduce((total, item) => total + item.sent, 0)} detail="enviadas no período" />
            </section>
          </article>
        </section>
      ) : null}

      {activeAdminTab === "settings" ? (
        <section className="admin-tab-page">
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Configurações</p>
                <h2>Admin</h2>
              </div>
            </div>
            <section className="admin-settings-grid">
              <div className="admin-settings-panel">
                <p className="panel-label">Notificações</p>
                <h2>Sino do painel</h2>
                <p>Receba avisos de rotas pendentes, suporte e erros do bot.</p>
                <button className="button primary" type="button" onClick={enableNotifications}>Ativar notificações</button>
              </div>
              <div className="admin-settings-panel">
                <p className="panel-label">Filtros</p>
                <h2>Visão atual</h2>
                <p>{activeClientLabel}</p>
                <button className="button" type="button" onClick={() => { setClientFilter("all"); setRouteKindFilter("all"); setRouteStatusFilter("all"); showAdminToast("Filtros resetados."); }}>Resetar filtros</button>
              </div>
              <div className="admin-settings-panel danger">
                <p className="panel-label">Sessão</p>
                <h2>Sair</h2>
                <p>Encerra seu acesso nesse navegador.</p>
                <button className="button danger" type="button" onClick={onLogout}>
                  <LogOut size={18} />
                  Sair do usuário
                </button>
              </div>
            </section>
          </article>
        </section>
      ) : null}

      {activeAdminTab === "clients" ? (
        <section className="admin-tab-page">
          <article className="command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Clientes</p>
                <h2>{usersDashboard.users.length} usuário(s)</h2>
              </div>
              <button className="button primary" type="button" onClick={() => setEditor(emptyUserEditor)}>
                <UserPlus size={18} />
                Adicionar
              </button>
            </div>
            {editor ? (
              <UserEditor
                value={editor}
                onChange={setEditor}
                onCancel={() => setEditor(undefined)}
                onSave={() => saveUser()}
                busy={busy}
                competitors={usersDashboard.users}
              />
            ) : null}
            <div className="user-list">
              {usersDashboard.users.map((user) => (
                <AdminUserRow
                  key={user.email}
                  user={user}
                  onDetails={() => openDetails(user.email)}
                  onEdit={() => setEditor({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400 })}
                  onToggleBlock={() => saveUser({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: !user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400 })}
                />
              ))}
            </div>
          </article>
        </section>
      ) : null}

      <nav className="bottom-nav admin-bottom-nav" aria-label="Navegação do admin">
        {adminTabs.map(({ id, label, Icon, badge }) => (
          <button className={activeAdminTab === id ? "active" : ""} key={id} type="button" onClick={() => setActiveAdminTab(id)}>
            {badge ? <b className="nav-badge">{badge}</b> : null}
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {error ? <p className="login-error">{error}</p> : null}

      {activeSection === "reactions" ? (
        <AdminSectionModal eyebrow="Validação" title="Reações para validar" onClose={() => setActiveSection(undefined)}>
          <div className="admin-section-summary">
            <strong>{filteredPendingRoutes.length}</strong>
            <span>rotas com reação aguardando sua confirmação em {activeClientLabel}.</span>
          </div>
          <div className="route-list">
            {filteredPendingRoutes.length ? (
              filteredPendingRoutes.map((route) => (
                <RouteRow
                  key={`pending-${route.id}`}
                  route={route}
                  onValidate={() => validateRoute(route.id)}
                  onReject={() => rejectRoute(route.id)}
                  onFilterClient={() => filterRouteClient(route.clientEmail)}
                  onDetails={() => setRouteDetail(route)}
                />
              ))
            ) : (
              <p className="qr-empty">Nenhuma reação pendente de validação.</p>
            )}
          </div>
        </AdminSectionModal>
      ) : null}

      {activeSection === "logs" ? (
        <AdminSectionModal eyebrow="Tempo real" title="Logs dos bots" onClose={() => setActiveSection(undefined)}>
          <div className="admin-section-summary">
            <strong>{filteredLogs.length}</strong>
            <span>eventos em tempo real para {activeClientLabel}. Abrir esta tela marca os logs como vistos.</span>
          </div>
          <div className="admin-log-list">
            {filteredLogs.length ? filteredLogs.map((log) => <AdminLogRow key={`${log.clientEmail}-${log.id}`} log={log} />) : <p className="qr-empty">Nenhum log recebido ainda.</p>}
          </div>
        </AdminSectionModal>
      ) : null}

      {activeSection === "routes" ? (
        <AdminSectionModal eyebrow="Histórico" title="Últimos 100 disparos" onClose={() => setActiveSection(undefined)}>
          <div className="admin-section-summary">
            <strong>{filteredRoutes.length}</strong>
            <span>histórico separado por origem com cliente: {activeClientLabel}.</span>
          </div>
          <AdminRouteHistory
            automaticRoutes={automaticRoutes}
            manualRoutes={manualRoutes}
            testRoutes={testRoutes}
            activeTab={routeHistoryTab}
            onTabChange={setRouteHistoryTab}
            onValidate={validateRoute}
            onReject={rejectRoute}
            onFilterClient={filterRouteClient}
            onDetails={setRouteDetail}
          />
        </AdminSectionModal>
      ) : null}

      {activeSection === "users" ? (
        <AdminSectionModal eyebrow="Acessos" title="Usuários do painel" onClose={() => setActiveSection(undefined)}>
          <div className="panel-heading">
            <div>
              <p className="panel-label">Controle</p>
              <h2>Gerenciar acessos</h2>
            </div>
            <button className="button primary" type="button" onClick={() => setEditor(emptyUserEditor)}>
              <UserPlus size={18} />
              Adicionar
            </button>
          </div>
          {editor ? (
            <UserEditor
              value={editor}
              onChange={setEditor}
              onCancel={() => setEditor(undefined)}
              onSave={() => saveUser()}
              busy={busy}
              competitors={usersDashboard.users}
            />
          ) : null}
          <div className="user-list">
            {usersDashboard.users.map((user) => (
              <AdminUserRow
                key={user.email}
                user={user}
                onDetails={() => openDetails(user.email)}
                onEdit={() => setEditor({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400 })}
                onToggleBlock={() => saveUser({ originalEmail: user.email, email: user.email, password: "", role: user.role, blocked: !user.blocked, color: user.color, dispatchPriorityLevel: 0, dispatchBeatsEmail: user.dispatchBeatsEmail || "", dispatchAdvantageMs: user.dispatchAdvantageMs || 400 })}
              />
            ))}
          </div>
        </AdminSectionModal>
      ) : null}

      {activeSection === "support" ? (
        <AdminSectionModal eyebrow="Chat interno" title="Mensagens dos clientes" onClose={() => setActiveSection(undefined)}>
          <div className="panel-heading">
            <div>
              <p className="panel-label">Notificações</p>
              <h2>{filteredUnreadSupport} não lida(s)</h2>
            </div>
            <button className="button" type="button" onClick={enableNotifications}>
              Ativar notificação
            </button>
          </div>
          <div className="support-message-list">
            {filteredSupportMessages.length ? filteredSupportMessages.map((message) => (
              <SupportMessageRow key={message.id} message={message} onMarkRead={() => readSupportMessage(message.id)} />
            )) : <p className="qr-empty">Nenhuma mensagem de cliente ainda.</p>}
          </div>
        </AdminSectionModal>
      ) : null}

      {activeSection === "settings" ? (
        <AdminSectionModal eyebrow="Configurações" title="Preferências do admin" onClose={() => { setActiveSection(undefined); setConfirmLogout(false); setConfirmCleanup(undefined); }}>
          <section className="admin-settings-grid">
            <div className="admin-settings-panel">
              <p className="panel-label">Notificações</p>
              <h2>Alertas do navegador</h2>
              <p>Use isso para receber aviso quando cliente chamar no painel ou quando aparecer reação importante.</p>
              <button className="button primary" type="button" onClick={enableNotifications}>
                Ativar notificações
              </button>
            </div>
            <div className="admin-settings-panel">
              <p className="panel-label">Filtro padrão</p>
              <h2>Visão atual</h2>
              <p>{activeClientLabel} · {routeKindFilter === "all" ? "todos os tipos" : "tipo filtrado"} · {routeStatusFilter === "all" ? "todos os status" : "status filtrado"}</p>
              <button className="button" type="button" onClick={() => { setClientFilter("all"); setRouteKindFilter("all"); setRouteStatusFilter("all"); }}>
                Resetar filtros
              </button>
            </div>
            <div className="admin-settings-panel danger">
              <p className="panel-label">Sessão</p>
              <h2>Sair do painel</h2>
              <p>A saída fica aqui para evitar clique sem querer durante monitoramento de rota.</p>
              {!confirmLogout ? (
                <button className="button" type="button" onClick={() => setConfirmLogout(true)}>
                  <LogOut size={18} />
                  Mostrar botão de sair
                </button>
              ) : (
                <button className="button danger" type="button" onClick={onLogout}>
                  Confirmar saída
                </button>
              )}
            </div>
            <div className="admin-settings-panel danger cleanup-panel">
              <p className="panel-label">Limpeza</p>
              <h2>Apagar históricos</h2>
              <p>Escopo: {activeClientLabel}. Use um filtro de cliente antes se quiser apagar só um cliente.</p>
              <div className="cleanup-actions">
                {[
                  { target: "logs" as CleanupTarget, label: "Logs do bot" },
                  { target: "routes" as CleanupTarget, label: "Histórico de disparos" },
                  { target: "support" as CleanupTarget, label: "Mensagens suporte" },
                  { target: "all" as CleanupTarget, label: "Tudo acima" }
                ].map((item) => (
                  <button
                    className={confirmCleanup === item.target ? "button danger" : "button"}
                    disabled={cleanupBusy}
                    key={item.target}
                    type="button"
                    onClick={() => runCleanup(item.target)}
                  >
                    {confirmCleanup === item.target ? `Confirmar: ${item.label}` : `Apagar ${item.label}`}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </AdminSectionModal>
      ) : null}

      {detail ? <UserDetailModal detail={detail} onClose={() => setDetail(undefined)} /> : null}
      {routeDetail ? <RouteDetailModal route={routeDetail} onClose={() => setRouteDetail(undefined)} /> : null}
      {actionToast ? <div className="action-toast">{actionToast}</div> : null}
      {logToast ? (
        <button className="admin-log-toast" type="button" onClick={() => setActiveSection("logs")}>
          <span>{unreadLogCount}</span>
          <div>
            <strong>Novo log</strong>
            <small>{logToast.clientEmail}</small>
            <p>{logToast.message}</p>
          </div>
        </button>
      ) : null}
      {leaderAlert ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="leader-alert-title">
            <p className="panel-label">Atenção</p>
            <h2 id="leader-alert-title">Reação encontrada</h2>
            <p className="confirmation-message">{leaderAlert}</p>
            <div className="confirmation-actions">
              <button className="button primary" type="button" onClick={() => setLeaderAlert("")}>
                Ver rotas
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const OCR_SUCCESS_SEEN_KEY = "bot-rotas:ocr-success-seen:v1";
const OCR_ANALYSIS_DISMISSED_KEY = "bot-rotas:ocr-analysis-dismissed:v1";

function readRememberedAnalysisIds(key: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberAnalysisId(key: string, analysisId?: string) {
  if (!analysisId) return;
  try {
    const ids = readRememberedAnalysisIds(key).filter((item) => item !== analysisId);
    window.localStorage.setItem(key, JSON.stringify([...ids, analysisId].slice(-100)));
  } catch {
    // A interface continua funcionando quando o navegador bloqueia o armazenamento local.
  }
}

function wasAnalysisRemembered(key: string, analysisId?: string) {
  return Boolean(analysisId && readRememberedAnalysisIds(key).includes(analysisId));
}

function AutomaticOcrAnalysisDialog({ selection, onClose, onConfirm, busy = false }: {
  selection?: OcrRouteSelectionState;
  onClose: () => void;
  onConfirm?: (optionIds: string[]) => Promise<void> | void;
  busy?: boolean;
}) {
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [showDispatchSuccess, setShowDispatchSuccess] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => setManualIds([]), [selection?.analysisId]);
  useEffect(() => {
    if (selection?.dispatchState !== "sent") return;
    const shouldShowSuccess = !wasAnalysisRemembered(OCR_SUCCESS_SEEN_KEY, selection.analysisId);
    if (shouldShowSuccess) rememberAnalysisId(OCR_SUCCESS_SEEN_KEY, selection.analysisId);
    setShowDispatchSuccess(shouldShowSuccess);
    const successTimer = shouldShowSuccess
      ? window.setTimeout(() => setShowDispatchSuccess(false), 4_000)
      : undefined;
    const analysisTimer = window.setTimeout(() => closeRef.current(), shouldShowSuccess ? 24_000 : 20_000);
    return () => {
      if (successTimer !== undefined) window.clearTimeout(successTimer);
      window.clearTimeout(analysisTimer);
    };
  }, [selection?.analysisId, selection?.dispatchCompletedAt, selection?.dispatchState]);
  if (!selection || selection.status === "idle") return null;
  const analyzing = selection.status === "analyzing";
  const finished = !analyzing;
  const selectedOptions = selection.selectedOptionIds?.length
    ? selection.options.filter((option) => selection.selectedOptionIds?.includes(option.id))
    : [];
  const manualOptions = selection.options.filter((option) => option.manualOnly);
  const toggleManualOption = (id: string) => setManualIds((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : current.length < 3 ? [...current, id] : current);
  const formatAnalysisTime = (milliseconds?: number) => {
    if (milliseconds === undefined) return "--";
    if (milliseconds < 1000) return `${milliseconds} ms`;
    return `${(milliseconds / 1000).toFixed(2).replace(".", ",")} s`;
  };

  return (
    <div className="modal-backdrop ocr-analysis-backdrop" role="presentation">
      <section className="sheet-dialog ocr-route-dialog automatic-analysis-dialog" role="dialog" aria-modal="true" aria-labelledby="automatic-analysis-title">
        <div className="sheet-heading">
          <div>
            <p className="panel-label">Bot imagem automático</p>
            <h2 id="automatic-analysis-title">{analyzing ? "Analisando a imagem" : selection.dispatchState === "sent" ? "Rotas enviadas!" : selection.status === "confirmed" ? "Rota pronta" : "Imagem verificada"}</h2>
          </div>
          <div className="automatic-analysis-heading-actions">
            {analyzing ? <span className="mini-badge">PROCESSANDO</span> : null}
            <button className="icon-button" title="Fechar análise e continuar usando o painel" aria-label="Fechar análise" type="button" onClick={onClose}><X size={20} /></button>
          </div>
        </div>
        <div className="automatic-analysis-steps">
          <article className="analysis-step done"><CheckCircle2 size={19} /><span><strong>Imagem recebida</strong><small>O servidor recebeu a foto do grupo.</small></span></article>
          <article className={analyzing ? "analysis-step active" : "analysis-step done"}>{analyzing ? <RefreshCw className="spin" size={19} /> : <CheckCircle2 size={19} />}<span><strong>Lendo bairros e gaiolas</strong><small>{analyzing ? "Conferindo a associação de cada bairro com sua gaiola na imagem." : manualOptions.length ? `${manualOptions.length} rota(s) detectada(s) para revisão.` : `${selection.detectedRouteCount || selection.options.length} bairro(s) preferido(s) confirmado(s).`}</small></span></article>
          <article className={analyzing ? "analysis-step" : "analysis-step done"}><Route size={19} /><span><strong>Conferindo as preferências</strong><small>{analyzing ? "Aguardando a leitura terminar." : selectedOptions.length ? "Preferência identificada e associação com a gaiola validada." : manualOptions.length ? "Sem correspondência automática; escolha manual disponível." : "Nenhuma escolha liberada para envio."}</small></span></article>
          <article className={selection.status === "confirmed" ? "analysis-step done" : analyzing ? "analysis-step" : "analysis-step active"}><Send size={19} /><span><strong>{selection.dispatchState === "sent" ? "Envio concluído" : selection.dispatchState === "sending" ? "Enviando agora" : manualOptions.length && selection.status !== "confirmed" ? "Confirmação manual" : "Disparo automático"}</strong><small>{selection.dispatchState === "sent" ? selection.message : selection.dispatchState === "sending" ? "Aguardando a confirmação do WhatsApp." : selection.status === "confirmed" ? `${selection.preparedMessages?.length || 0} rota(s) pronta(s); aguardando o grupo abrir.` : analyzing ? "Aguardando uma preferência com leitura segura." : selection.message || "Nenhuma mensagem liberada."}</small></span></article>
        </div>
        {selection.imagePreviewUrl ? (
          <figure className="automatic-analysis-preview">
            <figcaption>Imagem completa recebida do WhatsApp e usada na análise</figcaption>
            <AnalysisImage src={selection.imagePreviewUrl} alt="Imagem completa analisada pelo bot" />
          </figure>
        ) : null}
        {!analyzing && selection.timing ? (
          <div className="automatic-analysis-timing" aria-label="Tempos da análise e do envio">
            <span><small>Baixar imagem</small><strong>{formatAnalysisTime(selection.timing.downloadMs)}</strong></span>
            <span><small>Ler bairros e gaiolas</small><strong>{formatAnalysisTime(selection.timing.ocrMs)}</strong></span>
            <span><small>Conferir preferências</small><strong>{formatAnalysisTime(selection.timing.comparisonMs)}</strong></span>
            <span><small>Disparo</small><strong>{formatAnalysisTime(selection.timing.dispatchMs)}</strong></span>
            <span className="total"><small>Tempo total registrado</small><strong>{formatAnalysisTime(selection.timing.totalMs)}</strong></span>
          </div>
        ) : null}
        {!analyzing && selectedOptions.length ? <div className="automatic-analysis-routes">{selectedOptions.map((option) => <article key={option.id}><strong>{option.gaiola}</strong><span>{option.bairro}</span>{option.paradas ? <small>{option.paradas} paradas identificadas</small> : null}{option.pacotes ? <small>{option.pacotes} pacotes identificados</small> : null}{option.cidade ? <small>{option.cidade}</small> : null}{option.observation ? <small>{option.observation}</small> : null}{option.romaneioMatch === true ? <small>{option.pacotes} pct · {option.distanciaKm.toFixed(3)} km</small> : null}</article>)}</div> : null}
        {!analyzing && manualOptions.length && !selectedOptions.length ? (
          <div className="manual-route-review">
            <div><strong>Rotas encontradas</strong><small>Marque até 3 rotas. Nada será enviado sem sua confirmação.</small></div>
            <div className="automatic-analysis-routes">
              {manualOptions.map((option) => (
                <button key={option.id} type="button" className={manualIds.includes(option.id) ? "manual-route-option selected" : "manual-route-option"} onClick={() => toggleManualOption(option.id)}>
                  <span className="manual-route-check">{manualIds.includes(option.id) ? "✓" : ""}</span>
                  <strong>{option.gaiola}</strong><span>{option.bairro}</span>
                  {option.regiao ? <small>Região: {option.regiao}</small> : option.cidade ? <small>{option.cidade}</small> : null}
                  {option.paradas ? <small>{option.paradas} paradas</small> : null}
                  {option.pacotes ? <small>{option.pacotes} pacotes</small> : null}
                  {option.observation ? <small>{option.observation}</small> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {!analyzing && selection.message ? <p className={selection.status === "error" ? "inline-error" : "approval-message"}>{uiText(selection.message)}</p> : null}
        {!analyzing && selection.status === "error" && selection.line ? (
          <details className="automatic-analysis-diagnostic">
            <summary>Ver texto reconhecido pela IA</summary>
            <pre>{selection.line}</pre>
          </details>
        ) : null}
        {finished ? <div className="review-actions">
          {manualOptions.length && !selectedOptions.length && onConfirm ? <button className="button primary" disabled={busy || !manualIds.length} type="button" onClick={() => void onConfirm(manualIds)}>{busy ? "Enviando..." : `Enviar ${manualIds.length || ""} rota(s)`}</button> : null}
          <button className="button" type="button" onClick={onClose}>Fechar análise</button>
        </div> : null}
      </section>
      {showDispatchSuccess ? (
        <section className="dispatch-success-overlay" role="status" aria-live="assertive" aria-label="Envio concluído">
          <span className="dispatch-success-overlay-icon"><CheckCircle2 size={46} /></span>
          <p className="panel-label">Disparo concluído</p>
          <h2>Rota enviada com sucesso!</h2>
          <p>O WhatsApp confirmou o envio para <strong>{selection.dispatchGroupName || "o grupo alvo"}</strong>.</p>
          <div className="dispatch-success-overlay-routes">{(selection.preparedMessages || []).map((message) => <span key={message}>{message}</span>)}</div>
          <small>Voltando para os detalhes da análise...</small>
        </section>
      ) : null}
    </div>
  );
}

function ReleaseDialog({
  release,
  busy,
  error,
  onAcknowledge
}: {
  release: AppRelease;
  busy: boolean;
  error?: string;
  onAcknowledge: () => void;
}) {
  const publishedAt = new Date(release.publishedAt);
  const publishedLabel = Number.isNaN(publishedAt.getTime())
    ? ""
    : publishedAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="modal-backdrop release-backdrop" role="presentation">
      <section className="release-dialog" role="dialog" aria-modal="true" aria-labelledby="release-title">
        <div className="release-heading">
          <span className="release-icon" aria-hidden="true"><Sparkles size={24} /></span>
          <div>
            <p className="panel-label">Nova versão disponível</p>
            <h2 id="release-title">{release.title}</h2>
          </div>
        </div>
        <div className="release-meta">
          <strong>Versão {release.version}</strong>
          {publishedLabel ? <span>{publishedLabel}</span> : null}
        </div>
        <p className="release-summary">{release.summary}</p>
        <div className="release-change-list">
          {release.changes.map((change) => (
            <div className="release-change" key={change.title}>
              <CheckCircle2 size={19} aria-hidden="true" />
              <span>
                <strong>{change.title}</strong>
                <small>{change.description}</small>
              </span>
            </div>
          ))}
        </div>
        {error ? <p className="login-error">{error}</p> : null}
        <div className="confirmation-actions">
          <button className="button primary" disabled={busy} type="button" onClick={onAcknowledge}>
            {busy ? "Salvando..." : "Entendi, continuar"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(getPanelToken());
  useEffect(() => {
    const updateSession = () => setSession(getPanelToken());
    window.addEventListener(PANEL_SESSION_CHANGED, updateSession);
    window.addEventListener("storage", updateSession);
    return () => {
      window.removeEventListener(PANEL_SESSION_CHANGED, updateSession);
      window.removeEventListener("storage", updateSession);
    };
  }, []);
  return <PanelApp key={session || "signed-out"} />;
}

function PanelApp() {
  const sessionTokenRef = useRef(getPanelToken());
  const actionInFlightRef = useRef(false);
  const [snapshot, setSnapshot] = useState<BotSnapshot>(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return ["home", "groups", "image", "test", "settings"].includes(requested || "") ? requested as AppTab : "home";
  });
  const [groupEditor, setGroupEditor] = useState<GroupEditor>();
  const [authenticated, setAuthenticated] = useState(Boolean(window.botApi || getPanelToken()));
  const [userEmail, setUserEmail] = useState(getPanelUserEmail());
  const [userRole, setUserRole] = useState<PanelUserRole>(getPanelUserRole());
  const [impersonatedBy, setImpersonatedBy] = useState("");
  const [sessionChecked, setSessionChecked] = useState(Boolean(window.botApi || !getPanelToken()));
  const [loginError, setLoginError] = useState("");
  const [alertFlash, setAlertFlash] = useState(false);
  const [lastAlertLogId, setLastAlertLogId] = useState("");
  const [actionToast, setActionToast] = useState<ActionToast | undefined>();
  const [automaticOcrAnalysisOpen, setAutomaticOcrAnalysisOpen] = useState(false);
  const [ocrAnalysisHistoryOpen, setOcrAnalysisHistoryOpen] = useState(false);
  const [historyOcrSelection, setHistoryOcrSelection] = useState<OcrRouteSelectionState>();
  const [incidentValid, setIncidentValid] = useState(true);
  const [incidentReason, setIncidentReason] = useState("");
  const [incidentClock, setIncidentClock] = useState(Date.now());
  const [notificationStatus, setNotificationStatus] = useState("");
  const [dismissedRouteBillingNotice, setDismissedRouteBillingNotice] = useState(() => window.localStorage.getItem(`route-billing-notice:${getPanelUserEmail()}`) || "");
  const [releaseNotice, setReleaseNotice] = useState<AppRelease>();
  const [releaseAcknowledgeBusy, setReleaseAcknowledgeBusy] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const connectionSectionRef = useRef<HTMLElement | null>(null);

  function showActionToast(message: string, tone?: ActionToast["tone"]) {
    setActionToast({ message, tone });
    window.setTimeout(() => setActionToast(undefined), 1000);
  }

  function scrollToConnectionOptions(delayMs = 120) {
    window.setTimeout(() => {
      connectionSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, delayMs);
  }


  function logout(message = "") {
    void revokePanelSession().catch(() => console.warn("Sessão local encerrada; revogação remota indisponível."));
    setPanelToken("");
    setPanelUserEmail("");
    setPanelUserRole("");
    setPanelPassword("");
    setUserEmail("");
    setUserRole("client");
    setImpersonatedBy("");
    setAuthenticated(false);
    setSessionChecked(true);
    if (message) setLoginError(message);
  }

  useEffect(() => {
    if (!authenticated || window.botApi) return;

    let mounted = true;
    getPanelMe()
      .then((user) => {
        if (!mounted) return;
        setUserEmail(user.email);
        setUserRole(user.role);
        setImpersonatedBy(user.impersonatedBy || "");
        setSessionChecked(true);
        setLoginError("");
      })
      .catch((error) => {
        if (!mounted) return;
        if (isAuthError(error)) {
          logout(error instanceof Error ? error.message : "Faça login novamente.");
          return;
        }
        setSessionChecked(true);
        setLoginError(error instanceof Error ? error.message : "Falha ao validar sessão.");
      });

    return () => {
      mounted = false;
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    if (userRole === "admin") return;

    let mounted = true;
    if (window.botApi) botApi
      .getSnapshot()
      .then((nextSnapshot) => {
        if (mounted) {
          setSnapshot(nextSnapshot);
          setLoginError("");
        }
      })
      .catch((error) => {
        if (!mounted) return;
        if (isAuthError(error)) {
          logout(error instanceof Error ? error.message : "Faça login para continuar.");
          return;
        }
        setLoginError(error instanceof Error ? error.message : "Falha ao abrir painel.");
      });

    const unsubscribe = botApi.onSnapshot((nextSnapshot) => {
      if (mounted) setSnapshot(nextSnapshot);
    }, (error) => {
      if (mounted && isAuthError(error)) logout("Faça login para continuar.");
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [authenticated, userRole]);

  useEffect(() => {
    const reportRendererHeartbeat = () => botApi.reportRendererHeartbeat();
    reportRendererHeartbeat();
    document.addEventListener("visibilitychange", reportRendererHeartbeat);
    window.addEventListener("focus", reportRendererHeartbeat);
    window.addEventListener("pageshow", reportRendererHeartbeat);
    const heartbeat = window.setInterval(reportRendererHeartbeat, 4000);
    return () => {
      document.removeEventListener("visibilitychange", reportRendererHeartbeat);
      window.removeEventListener("focus", reportRendererHeartbeat);
      window.removeEventListener("pageshow", reportRendererHeartbeat);
      window.clearInterval(heartbeat);
    };
  }, []);

  useEffect(() => {
    if (!authenticated || window.botApi) return;
    let mounted = true;
    getReleaseNotice()
      .then((notice) => {
        if (!mounted || !notice.shouldShow) return;
        setReleaseNotice(notice.release);
        setReleaseError("");
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [authenticated, userRole]);

  useEffect(() => {
    const selection = snapshot.ocrRouteSelection;
    if (snapshot.config.targetDispatchMode !== "ocr") {
      setAutomaticOcrAnalysisOpen(false);
      return;
    }
    if (selection && selection.status !== "idle" && !wasAnalysisRemembered(OCR_ANALYSIS_DISMISSED_KEY, selection.analysisId)) {
      if (selection.status === "analyzing") setActiveTab("image");
      setAutomaticOcrAnalysisOpen(true);
    }
  }, [snapshot.config.targetDispatchMode, snapshot.ocrRouteSelection?.analysisId, snapshot.ocrRouteSelection?.processedAt, snapshot.ocrRouteSelection?.status]);

  useEffect(() => {
    const selection = snapshot.ocrRouteSelection;
    if (!automaticOcrAnalysisOpen || !selection || !["ready", "error"].includes(selection.status) || selection.preparedMessages?.length) return;
    if (selection.options.some((option) => option.manualOnly)) return;
    const timer = window.setTimeout(() => setAutomaticOcrAnalysisOpen(false), 45_000);
    return () => window.clearTimeout(timer);
  }, [automaticOcrAnalysisOpen, snapshot.ocrRouteSelection?.analysisId, snapshot.ocrRouteSelection?.processedAt, snapshot.ocrRouteSelection?.status]);

  const neighborhoodPreferences = getNeighborhoodPreferences(snapshot.config);
  const detectedRegions = useMemo(() => [...new Set([
    ...(snapshot.ocrRouteSelection?.options || []),
    ...(snapshot.ocrAnalysisHistory || []).flatMap((analysis) => analysis.options || [])
  ].map((option) => option.regiao || "").filter(Boolean))], [snapshot.ocrRouteSelection, snapshot.ocrAnalysisHistory]);

  const groupLabel = useMemo(() => {
    return snapshot.config.grupoAlvoNome || "Nenhum grupo alvo";
  }, [snapshot.config]);

  const testGroupLabel = useMemo(() => {
    return snapshot.config.grupoTesteNome || "Nenhum teste salvo";
  }, [snapshot.config]);

  const pendingClientIncident = useMemo(() => {
    if (userRole === "admin") return undefined;
    return (snapshot.routeDispatches || []).find((route) => isClientIncidentDue(route, incidentClock));
  }, [snapshot.routeDispatches, userRole, incidentClock]);

  const pendingIncidentAuditLines = useMemo(() => {
    return pendingClientIncident ? getIncidentAuditLines(pendingClientIncident) : [];
  }, [pendingClientIncident]);

  useEdgeSwipeBack(() => {
    if (confirmation && !busy) return setConfirmation(undefined);
    if (historyOcrSelection) return setHistoryOcrSelection(undefined);
    if (automaticOcrAnalysisOpen) return setAutomaticOcrAnalysisOpen(false);
    if (groupEditor && !busy) return setGroupEditor(undefined);
    if (ocrAnalysisHistoryOpen) return setOcrAnalysisHistoryOpen(false);
    if (activeTab !== "home") setActiveTab("home");
  }, !releaseNotice && !pendingClientIncident);

  const pendingIncidentSnoozeDelay = pendingClientIncident ? getIncidentSnoozeDelayMinutes(pendingClientIncident) : undefined;
  const homeTimelineLogs = useMemo(() => snapshot.logs.filter((log) => !isImageOperationLog(log.message)), [snapshot.logs]);
  const visibleHomeTimelineLogs = useMemo(() => homeTimelineLogs.slice(0, 80), [homeTimelineLogs]);

  useEffect(() => {
    const timer = window.setInterval(() => setIncidentClock(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pendingClientIncident) {
      setIncidentReason("");
      setIncidentValid(true);
    }
  }, [pendingClientIncident?.id]);

  useEffect(() => {
    const lastLog = snapshot.logs[0];
    if (!lastLog || lastLog.id === lastAlertLogId) return;

    const shouldAlert = /ABRIU|Abertura simulada|Disparo acionado|Disparo .*conclu|Mensagem alvo \d+ enviada/i.test(lastLog.message);
    if (!shouldAlert) return;

    setLastAlertLogId(lastLog.id);
    setAlertFlash(true);
    window.setTimeout(() => setAlertFlash(false), 900);

    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const audio = new AudioContextClass();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.2);
      window.setTimeout(() => void audio.close(), 260);
    } catch {
      // Browsers can block sound before user interaction.
    }
  }, [lastAlertLogId, snapshot.logs]);

  async function runAction(action: () => Promise<BotSnapshot>) {
    if (actionInFlightRef.current || getPanelToken() !== sessionTokenRef.current) return snapshot;
    actionInFlightRef.current = true;
    setBusy(true);
    try {
      const nextSnapshot = await action();
      setSnapshot(nextSnapshot);
      showActionToast("Ação concluída.");
      return nextSnapshot;
    } catch (error) {
      if (isAuthError(error)) {
        logout(error instanceof Error ? error.message : "Entre novamente para continuar.");
      } else {
        setConfirmation({
          title: "Erro",
          message: error instanceof Error ? error.message : "Não consegui executar essa ação.",
          details: [],
          confirmLabel: "Fechar",
          onConfirm: () => undefined
        });
      }
      return snapshot;
    } finally {
      actionInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function startWhatsAppConnection() {
    await runAction(botApi.startBot);
    scrollToConnectionOptions(180);
  }

  function buildMessagePreview(senderName = snapshot.config.nomeEnvio, codes = snapshot.config.codigosMensagensAlvo) {
    return normalizeMessages(senderName, codes || []);
  }

  function buildRoutePreview(routes = snapshot.config.rotasMonitoradas, detailedRoutes = snapshot.config.rotasMonitoradasDetalhadas) {
    return formatOcrRoutes(routes || [], detailedRoutes || []).map((route, index) => `Prioridade ${index + 1}: ${route}`);
  }

  function isHomeOperationLog(message: string) {
    return /Bot .*ARMADO|NORMAL ARMADO|NUCLEAR ARMADO|Monitoramento desativado|Parou de escutar|FECHADO|ABRIU|Palavra de abertura|Abertura simulada|Disparo acionado|Rajada instantânea|Mensagem .*?(confirmada|enviada)|Disparo .*?(concluído|concluido|terminou)|Abertura ignorada|falhou|erro/i.test(message);
  }

  function isImageOperationLog(message: string) {
    return /OCR|IA|imagem|foto|romaneio|rota\(s\)|rotas encontradas|Ranking de rotas|Cliente confirmou|gaiola/i.test(message);
  }

  function confirmSaveTarget(group: string, groupId: string | undefined, groupName: string | undefined, senderName: string, codes: string[], _messageCount?: number, _intervalMs?: number, startAfterSave = false, monitoredRoutes?: MonitoredRoute[], targetDispatchMode: "manual" | "ocr" = "manual", ocrCageMessageLimit = 3, ocrMaxStops = 0, ocrMaxPackages = 0, ocrRouteChoiceMode: BotConfig["ocrRouteChoiceMode"] = "quantity", ocrRouteChoiceMetric: BotConfig["ocrRouteChoiceMetric"] = "stops") {
    const selectedGroupName = groupName || group;
    const isImageMode = targetDispatchMode === "ocr";
    const preferences = isImageMode ? normalizeNeighborhoodPreferences(monitoredRoutes || codes.map((bairro) => ({ cidade: "", bairro }))) : [];
    const activePreferences = getEnabledNeighborhoodPreferences(preferences);
    if (isImageMode && (!preferences.length || (startAfterSave && !activePreferences.length))) {
      showActionToast("Adicione pelo menos um bairro preferido.", "manual");
      return;
    }
    const routes = preferences.map((route) => route.bairro);
    const messages = isImageMode ? buildRoutePreview(activePreferences.map((route) => route.bairro), activePreferences) : buildMessagePreview(senderName, codes);

    setConfirmation({
      title: startAfterSave ? (isImageMode ? "Salvar e iniciar imagem" : "Salvar e iniciar manual") : isImageMode ? "Salvar bot imagem" : "Salvar mensagens",
      message: `Grupo alvo: ${selectedGroupName}`,
      details: isImageMode ? [...messages, ocrRouteChoiceMode === "preference" ? "Cérebro: seguir a ordem de preferência dos bairros." : `Cérebro: escolher primeiro a rota com menos ${ocrRouteChoiceMetric === "packages" ? "pacotes" : "paradas"}.`, `Serão enviadas até ${ocrCageMessageLimit} mensagens.`, ocrMaxStops ? `Limite geral: ${ocrMaxStops} paradas.` : "Sem limite geral de paradas.", ocrMaxPackages ? `Limite geral: ${ocrMaxPackages} pacotes.` : "Sem limite geral de pacotes."] : messages,
      confirmLabel: startAfterSave ? "Salvar e iniciar" : "Salvar",
      onConfirm: async () => {
        await runAction(async () => {
          await botApi.saveGroup({ group, groupId, groupName });
          await botApi.saveTargetMessageSettings({
            senderName,
            codes: isImageMode ? snapshot.config.codigosMensagensAlvo || [] : codes,
            routes: isImageMode ? routes : snapshot.config.rotasMonitoradas || [],
            monitoredRoutes: isImageMode ? preferences : snapshot.config.rotasMonitoradasDetalhadas || [],
            targetDispatchMode,
            ocrCageMessageLimit,
            ocrMaxStops,
            ocrMaxPackages,
            ocrRouteChoiceMode,
            ocrRouteChoiceMetric
          });
          setGroupEditor(undefined);
          return startAfterSave ? (isImageMode ? botApi.startImageMonitoring() : botApi.startMonitoring()) : botApi.getSnapshot();
        });
      }
    });
  }

  function confirmSaveTest(group: string, groupId: string | undefined, groupName: string | undefined, senderName: string, codes: string[], messageCount = 15, intervalMs = 0) {
    const selectedGroupName = groupName || group;
    const messages = buildMessagePreview(senderName, codes);

    setConfirmation({
      title: "Salvar teste",
      message: `Grupo teste: ${selectedGroupName}`,
      details: messages.length ? messages : ["Nenhuma mensagem pronta."],
      confirmLabel: "Salvar teste",
      onConfirm: async () => {
        await runAction(async () => {
          await botApi.saveTestGroup({ group, groupId, groupName });
          setGroupEditor(undefined);
          return botApi.saveWarmupMessageSettings({ senderName, codes, messageCount, intervalMs });
        });
      }
    });
  }

  function confirmSaveManualTarget(group: string, groupId: string | undefined, groupName: string | undefined, senderName: string, codes: string[]) {
    const selectedGroupName = groupName || group;
    const messages = buildMessagePreview(senderName, codes);

    setConfirmation({
      title: "Salvar manual avançado",
      message: `Grupo alvo: ${selectedGroupName}`,
      details: messages.length ? messages : ["Nenhum código manual."],
      confirmLabel: "Salvar manual",
      onConfirm: async () => {
        await runAction(async () => {
          await botApi.saveGroup({ group, groupId, groupName });
          await botApi.saveTargetMessageSettings({ senderName, codes, routes: snapshot.config.rotasMonitoradas || [], monitoredRoutes: snapshot.config.rotasMonitoradasDetalhadas || [] });
          setGroupEditor(undefined);
          return botApi.getSnapshot();
        });
      }
    });
  }

  function confirmStartMonitoring() {
    const manualMessages = buildMessagePreview();
    const hasGroup = Boolean(snapshot.config.grupoAlvoJid || snapshot.config.grupoAlvoNome);
    const hasName = Boolean(snapshot.config.nomeEnvio);

    if (!hasGroup || !hasName || !manualMessages.length) {
      setGroupEditor("target");
      setConfirmation({
        title: "Revise o envio",
        message: "Falta configurar o grupo, o nome ou os códigos manuais.",
        details: [
          hasGroup ? `Rota: ${groupLabel}` : "Rota ainda não configurada.",
          hasName ? `Nome: ${snapshot.config.nomeEnvio}` : "Nome ainda não configurado.",
          manualMessages.length ? `Mensagens: ${manualMessages.join(" | ")}` : "Nenhum código manual configurado."
        ],
        confirmLabel: "Entendi",
        onConfirm: () => undefined
      });
      return;
    }

    setConfirmation({
      title: "Iniciar bot manual",
      message: "Confira a rota e as mensagens manuais que serão enviadas.",
      details: [
        `Grupo alvo: ${groupLabel}`,
        `Nome: ${snapshot.config.nomeEnvio}`,
        `Mensagens manuais: ${manualMessages.join(" | ")}`
      ],
      confirmLabel: "Iniciar manual",
      onConfirm: async () => {
        await runAction(botApi.startMonitoring);
      }
    });
  }

  function confirmStartImageMonitoring() {
    const hasGroup = Boolean(snapshot.config.grupoAlvoJid || snapshot.config.grupoAlvoNome);
    const hasName = Boolean(snapshot.config.nomeEnvio.trim());
    const activeNeighborhoodPreferences = getEnabledNeighborhoodPreferences(neighborhoodPreferences);
    const hasNeighborhoods = activeNeighborhoodPreferences.length > 0;

    if (!hasGroup || !hasName) {
      setGroupEditor("image");
      setConfirmation({
        title: "Revise o bot imagem",
        message: "Configure o grupo e o nome de envio.",
        details: [
          hasGroup ? `Grupo: ${groupLabel}` : "Grupo alvo ainda não configurado.",
          hasName ? `Nome: ${snapshot.config.nomeEnvio}` : "Nome ainda não configurado."
        ],
        confirmLabel: "Entendi",
        onConfirm: () => undefined
      });
      return;
    }

    setConfirmation({
      title: "Iniciar bot imagem",
      message: hasNeighborhoods
        ? `O bot vai procurar os bairros na ordem salva e preparar até ${Math.max(1, Math.min(3, snapshot.config.ocrCageMessageLimit || 3))} mensagens com leitura segura.`
        : "O bot vai detectar as rotas da imagem e pedir confirmação antes de enviar.",
      details: [
        `Grupo alvo: ${groupLabel}`,
        `Nome: ${snapshot.config.nomeEnvio}`,
        ...(hasNeighborhoods
          ? activeNeighborhoodPreferences.map((route, index) => `${index + 1}ª preferência ativa: ${neighborhoodPreferenceLabel(route)}`)
          : ["Sem bairros ativos: as rotas detectadas aparecerão para escolha manual."]),
        "O automático exige leitura segura. Em caso de dúvida, nada é enviado sem confirmação."
      ],
      confirmLabel: "Iniciar imagem",
      onConfirm: async () => {
        await runAction(botApi.startImageMonitoring);
      }
    });
  }

  function confirmStartTestMonitoring() {
    const messages = normalizeMessages(snapshot.config.nomeEnvio, snapshot.config.codigosMensagensTeste || []);

    setConfirmation({
      title: "Teste abrir/fechar",
      message: "Deseja testar abrindo e fechando o grupo?",
      details: [
        `Grupo teste: ${testGroupLabel}`,
        messages.length ? `Mensagens: ${messages.join(" | ")}` : "Nenhuma mensagem de teste configurada."
      ],
      confirmLabel: "Testar grupo",
      onConfirm: async () => {
        await runAction(botApi.startTestMonitoring);
      }
    });
  }

  function confirmWarmup() {
    const config = snapshot.config;
    setConfirmation({
      title: "Testar envio",
      message: "Deseja enviar as mensagens de teste agora?",
      details: [
        config.grupoTesteNome || config.grupoTesteJid
          ? `Grupo teste: ${testGroupLabel}`
          : "Nenhum grupo de teste configurado.",
        `${snapshot.warmupMessagesSent || 0}/${snapshot.warmupRequiredMessages || 15} mensagens no último teste.`
      ],
      confirmLabel: "Testar envio",
      onConfirm: async () => {
        await runAction(botApi.warmupGroups);
      }
    });
  }

  function confirmManualDispatch() {
    const messages = buildMessagePreview();
    setConfirmation({
      title: "Disparo manual",
      message: snapshot.groupState === "closed"
        ? "O grupo ainda parece fechado. Se clicar agora, o sistema vai bloquear e registrar o aviso."
        : "Deseja disparar manualmente no grupo alvo agora?",
      details: [
        `Grupo alvo: ${groupLabel}`,
        `Estado atual: ${snapshot.groupState === "open" ? "aberto" : snapshot.groupState === "closed" ? "fechado" : "desconhecido"}`,
        messages.length ? `Mensagens manuais: ${messages.join(" | ")}` : "Nenhuma mensagem manual configurada. O modo principal usa análise de foto."
      ],
      confirmLabel: "Disparar agora",
      onConfirm: async () => {
        await runAction(botApi.manualDispatch);
      }
    });
  }

  function confirmSimulateTargetDispatch() {
    const messages = buildMessagePreview();
    setConfirmation({
      title: "Simular alvo",
      message: "Deseja enviar no grupo teste exatamente as mensagens que iriam para o grupo alvo?",
      details: [
        `Grupo teste: ${testGroupLabel}`,
        messages.length ? `Mensagens alvo: ${messages.join(" | ")}` : "Nenhuma mensagem alvo configurada."
      ],
      confirmLabel: "Simular alvo",
      onConfirm: async () => {
        await runAction(botApi.simulateTargetDispatch);
      }
    });
  }

  function confirmClearLogs() {
    setConfirmation({
      title: "Limpar logs",
      message: "Deseja apagar os logs exibidos no painel?",
      details: [`${snapshot.logs.length} evento(s) no painel.`],
      confirmLabel: "Limpar logs",
      onConfirm: async () => {
        await runAction(botApi.clearLogs);
      }
    });
  }

  function confirmFactoryReset() {
    setConfirmation({
      title: "Resetar tudo",
      message: "Deseja apagar sessão do WhatsApp e todas as configurações salvas?",
      details: ["O bot vai voltar zerado, com grupos, nome e mensagens em branco.", "Depois do reset será necessário conectar o WhatsApp novamente."],
      confirmLabel: "Resetar tudo",
      onConfirm: async () => {
        await runAction(botApi.factoryReset);
      }
    });
  }

  async function submitIncidentAnswer() {
    if (!pendingClientIncident || !incidentReason.trim()) return;
    await runAction(() => botApi.submitRouteIncident({
      routeId: pendingClientIncident.id,
      valid: incidentValid,
      reason: incidentReason.trim()
    }));
    setIncidentReason("");
  }

  async function handleEnableNotifications() {
    setBusy(true);
    setNotificationStatus("");
    try {
      await enableWebPushNotifications();
      setNotificationStatus("Alertas ativados neste dispositivo.");
      showActionToast("Alertas em segundo plano ativados.");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Não consegui ativar os alertas.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledgeRelease() {
    if (!releaseNotice) return;
    setReleaseAcknowledgeBusy(true);
    setReleaseError("");
    try {
      await acknowledgeRelease(releaseNotice.id);
      setReleaseNotice(undefined);
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : "Não consegui confirmar a leitura. Tente novamente.");
    } finally {
      setReleaseAcknowledgeBusy(false);
    }
  }

  async function handleEnterClientMode(email: string) {
    const user = await enterClientMode(email);
    setUserEmail(user.email);
    setUserRole(user.role);
    setImpersonatedBy(user.impersonatedBy || "");
    setReleaseNotice(undefined);
    setActiveTab("home");
  }

  async function handleReturnToAdminMode() {
    setBusy(true);
    try {
      const user = await returnToAdminMode();
      setUserEmail(user.email);
      setUserRole(user.role);
      setImpersonatedBy("");
      setReleaseNotice(undefined);
      setLoginError("");
    } catch (error) {
      setConfirmation({
        title: "Não consegui voltar ao admin",
        message: error instanceof Error ? error.message : "A sessão de teste não pôde ser encerrada.",
        details: ["Saia da conta e entre novamente com o usuário administrador se o problema continuar."],
        confirmLabel: "Fechar",
        onConfirm: () => undefined
      });
    } finally {
      setBusy(false);
    }
  }

  async function snoozePendingClientIncident() {
    if (!pendingClientIncident || !pendingIncidentSnoozeDelay) return;
    await runAction(() => botApi.snoozeRouteIncident({ routeId: pendingClientIncident.id }));
    setIncidentClock(Date.now());
  }

  async function confirmPendingAction() {
    if (!confirmation) return;
    const action = confirmation.onConfirm;
    setConfirmation(undefined);
    await action();
  }

  async function login(email: string, password: string) {
    try {
      const user = await panelLogin(email, password);
      setUserEmail(user.email);
      setUserRole(user.role);
      setImpersonatedBy("");
      setSessionChecked(true);
      setAuthenticated(true);
      setLoginError("");
    } catch (error) {
      setPanelToken("");
      setPanelUserRole("");
      setLoginError(error instanceof Error ? error.message : "Não consegui fazer login.");
    }
  }

  if (!sessionChecked) {
    return <LoadingScreen />;
  }

  if (!authenticated) {
    return <LoginScreen error={loginError} onSubmit={login} />;
  }

  if (userRole === "admin") {
    return (
      <>
        <AdminCommandCenter
          userEmail={userEmail}
          onLogout={() => logout("Entre novamente para continuar.")}
          onEnterClientMode={handleEnterClientMode}
        />
        {releaseNotice ? (
          <ReleaseDialog
            release={releaseNotice}
            busy={releaseAcknowledgeBusy}
            error={releaseError}
            onAcknowledge={() => void handleAcknowledgeRelease()}
          />
        ) : null}
      </>
    );
  }

  return (
    <main className={alertFlash ? "app-shell alert-flash" : "app-shell"}>
      <ParticleBackdrop />
      <ElectricCracks />
      <ForegroundSparks />
      <div className="bot-ambient" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <section className="topbar app-topbar">
        <div>
          <p className="eyebrow">Central operacional</p>
          <h1>Bot Rotas</h1>
        </div>
        {impersonatedBy ? (
          <div className="client-mode-banner">
            <span>
              <small>Modo cliente de teste</small>
              <strong>{userEmail}</strong>
            </span>
            <button className="button" disabled={busy} type="button" onClick={() => void handleReturnToAdminMode()}>
              <LogOut size={17} />
              Voltar ao admin
            </button>
          </div>
        ) : null}
        <div className="group-pill">
          <span>{snapshot.monitoringMode === "test" ? "Teste ativo" : "Grupo alvo"}</span>
          <strong>{snapshot.monitoringMode === "test" ? testGroupLabel : groupLabel}</strong>
        </div>
      </section>
      {snapshot.imageUsage?.billingReminder ? (
        <section className="client-billing-reminder" role="status">
          <CircleDollarSign size={18} />
          <span><strong>Lembrete de pagamento</strong><small>{snapshot.imageUsage.billingReminder}</small></span>
        </section>
      ) : null}
      {snapshot.imageUsage?.latestNotice && snapshot.imageUsage.latestNotice.id !== dismissedRouteBillingNotice ? (
        <section className="client-route-billing-notice" role="status">
          <CircleDollarSign size={18} />
          <span>{snapshot.imageUsage.latestNotice.text}</span>
          <button className="icon-button" type="button" aria-label="Fechar aviso" onClick={() => {
            const id = snapshot.imageUsage?.latestNotice?.id || "";
            setDismissedRouteBillingNotice(id);
            window.localStorage.setItem(`route-billing-notice:${userEmail}`, id);
          }}><X size={16} /></button>
        </section>
      ) : null}

      {activeTab === "home" ? (
        <section className="mobile-home">
          <EngineVisualPanel snapshot={snapshot} />

          <CockpitPanel snapshot={snapshot} groupLabel={snapshot.monitoringMode === "test" ? testGroupLabel : groupLabel} />

          <LaunchReviewPanel
            snapshot={snapshot}
            groupLabel={groupLabel}
            messages={normalizeMessages(snapshot.config.nomeEnvio, snapshot.config.codigosMensagensAlvo || [])}
            onEditTarget={() => setGroupEditor("target")}
          />

          <ControlButtons
            busy={busy}
            status={snapshot.status}
            onStart={startWhatsAppConnection}
            onStop={() => runAction(botApi.stopBot)}
            onStartMonitoring={confirmStartMonitoring}
            onStopMonitoring={() => runAction(botApi.stopMonitoring)}
            onManualDispatch={confirmManualDispatch}
            monitoringEnabled={snapshot.monitoringEnabled}
            monitoringMode={snapshot.monitoringMode}
            groupState={snapshot.groupState}
          />

          <LogsPanel logs={visibleHomeTimelineLogs} clearDisabled={busy} onClear={confirmClearLogs} />

          <PerformanceStrip snapshot={snapshot} />

          <section ref={connectionSectionRef} className="connection-anchor">
            {snapshot.qrCode || snapshot.status === "waiting_qr" || snapshot.status === "connecting" ? (
              <QrCodeBox
                qrCode={snapshot.qrCode}
                status={snapshot.status}
                qrGeneratedAt={snapshot.qrGeneratedAt}
                qrExpiresAt={snapshot.qrExpiresAt}
                qrAttempt={snapshot.qrAttempt}
                busy={busy}
                onRefreshQrCode={() => runAction(botApi.refreshQrCode)}
              />
            ) : null}
          </section>
        </section>
      ) : null}

      {activeTab === "groups" ? (
        <section className="mobile-home">
          <section className="quick-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Configuração</p>
                <h2>Grupos do bot</h2>
              </div>
              <button className="icon-button" disabled={busy} title="Atualizar grupos" type="button" onClick={() => runAction(botApi.refreshGroups)}>
                <RefreshCw size={20} />
              </button>
            </div>
            <ConfigStrip
              kind="target"
              title="Config grupo alvo"
              group={groupLabel}
              codes={snapshot.config.codigosMensagensAlvo || []}
              onOpen={() => setGroupEditor("target")}
            />
          </section>
        </section>
      ) : null}

      {activeTab === "image" ? (
        <section className="mobile-home">
          <section className="quick-panel identity-panel">
            <div>
              <p className="panel-label">Bot imagem</p>
              <h2>Seus bairros preferidos</h2>
            </div>
            <button className="button" type="button" onClick={() => setGroupEditor("image")}>
              Configurar bairros
            </button>
          </section>
          <section className="quick-panel client-usage-panel">
            <div className="client-usage-head">
              <div className="client-usage-icon"><BrainCircuit size={22} /></div>
              <div>
                <p className="panel-label">Financeiro</p>
                <h2>Saldo em aberto</h2>
                <small>{snapshot.imageUsage?.unpaidRoutes || 0} rota(s) em aberto</small>
              </div>
              <strong>{((snapshot.imageUsage?.amountCents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong>
            </div>
          </section>
          <section className="quick-panel ocr-analysis-history-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Consultas anteriores</p>
                <h2>Histórico de análises</h2>
              </div>
              <button className="button" type="button" onClick={() => setOcrAnalysisHistoryOpen((open) => !open)}>
                <Clock3 size={18} /> {ocrAnalysisHistoryOpen ? "Ocultar" : "Ver histórico"}
              </button>
            </div>
            {ocrAnalysisHistoryOpen ? (
              <div className="ocr-analysis-history-list">
                {(snapshot.ocrAnalysisHistory || []).map((analysis) => {
                  const chosen = analysis.selectedOptionIds?.length
                    ? analysis.options.filter((option) => analysis.selectedOptionIds?.includes(option.id))
                    : [];
                  return (
                    <button className="ocr-analysis-history-item" key={analysis.analysisId || analysis.processedAt} type="button" onClick={() => setHistoryOcrSelection(analysis)}>
                      <span><strong>{chosen.map((option) => `${option.gaiola} · ${option.bairro}`).filter(Boolean).join(", ") || "Nenhuma preferência selecionada"}</strong><small>{formatDate(analysis.processedAt)}</small></span>
                      <small>{analysis.status === "confirmed" ? `${analysis.preparedMessages?.length || 0} mensagem(ns) preparada(s)` : uiText(analysis.message || "Análise concluída")}</small>
                    </button>
                  );
                })}
                {!snapshot.ocrAnalysisHistory?.length ? <p className="qr-empty">As próximas análises aparecerão aqui automaticamente.</p> : null}
              </div>
            ) : null}
          </section>
          <section className="quick-panel ocr-mode-panel tone-auto">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Escolha automática</p>
                <h2>Ordem de preferência dos bairros</h2>
              </div>
              <button className="button" disabled={busy} type="button" onClick={() => setGroupEditor("image")}>Editar preferências</button>
            </div>
            <p className="approval-message">O bot identifica os bairros e confere a região somente para Centro. Depois aplica os limites e ordena {snapshot.config.ocrRouteChoiceMode === "preference" ? "pela sua preferência" : `pelo menor número de ${snapshot.config.ocrRouteChoiceMetric === "packages" ? "pacotes" : "paradas"}`}. Pode enviar até {snapshot.config.ocrCageMessageLimit || 3} rota(s) por imagem.</p>
            <div className={`ocr-quantity-limit-notice ${snapshot.config.ocrMaxStops || snapshot.config.ocrMaxPackages ? "has-limits" : ""}`}>
              <strong>{snapshot.config.ocrMaxStops || snapshot.config.ocrMaxPackages ? "Limites gerais que podem bloquear o envio" : "Sem limites gerais de paradas ou pacotes"}</strong>
              {snapshot.config.ocrMaxStops || snapshot.config.ocrMaxPackages ? (
                <>
                  <span>{[snapshot.config.ocrMaxStops ? `Máximo de ${snapshot.config.ocrMaxStops} paradas` : "", snapshot.config.ocrMaxPackages ? `máximo de ${snapshot.config.ocrMaxPackages} pacotes` : ""].filter(Boolean).join(" e ")}. Mesmo com bairro e região corretos, acima disso não envia automaticamente.</span>
                  <button className="button" disabled={busy} type="button" onClick={() => setGroupEditor("image")}>Revisar limites</button>
                </>
              ) : null}
            </div>
            <div className="confirmation-details">
              {neighborhoodPreferences.length ? neighborhoodPreferences.map((route, index) => (
                <span key={`${route.bairro}-${route.regiao || ""}-${index}`}>{index + 1}ª preferência: {neighborhoodPreferenceLabel(route)}{route.enabled === false ? " — pausada" : ""}</span>
              )) : <span>Adicione seus bairros preferidos antes de iniciar o bot imagem.</span>}
            </div>
          </section>
          <ControlButtons
            busy={busy}
            status={snapshot.status}
            onStart={startWhatsAppConnection}
            onStop={() => runAction(botApi.stopBot)}
            onStartMonitoring={confirmStartImageMonitoring}
            onStopMonitoring={() => runAction(botApi.stopMonitoring)}
            onManualDispatch={confirmManualDispatch}
            startMonitoringLabel="Iniciar bot imagem"
            hideManualDispatch
            monitoringEnabled={snapshot.monitoringEnabled && snapshot.config.targetDispatchMode === "ocr"}
            monitoringMode={snapshot.monitoringMode}
            groupState={snapshot.groupState}
          />
          <LogsPanel logs={snapshot.logs.filter((log) => isImageOperationLog(log.message)).slice(0, 60)} />
        </section>
      ) : null}

      {activeTab === "test" ? (
        <section className="mobile-home">
          <section className="quick-panel test-command-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Grupo de teste</p>
                <h2>{testGroupLabel}</h2>
              </div>
              <span className={snapshot.testStatus?.active ? "mini-badge ok" : "mini-badge"}>
                {snapshot.testStatus?.active ? "Rodando" : "Parado"}
              </span>
            </div>
            <div className="review-grid">
              <article className="review-item ok">
                <span>Quantidade</span>
                <strong>{snapshot.config.testMessageCount || 15}</strong>
              </article>
              <article className="review-item ok">
                <span>Intervalo</span>
                <strong>{snapshot.config.testMessageIntervalMs || 0}ms</strong>
              </article>
              <article className="review-item ok">
                <span>Último teste</span>
                <strong>{snapshot.testStatus?.lastSentCount || 0}/{snapshot.testStatus?.configuredMessageCount || snapshot.config.testMessageCount || 15}</strong>
              </article>
            </div>
            <div className="review-actions">
              <button className="button" type="button" onClick={() => setGroupEditor("test")}>
                Configurar teste
              </button>
              {snapshot.testStatus?.active ? (
                <button className="button danger" disabled={busy} type="button" onClick={() => runAction(botApi.stopMonitoring)}>
                  Parar teste
                </button>
              ) : (
                <button className="button primary" disabled={busy || snapshot.status !== "connected"} type="button" onClick={confirmWarmup}>
                  Iniciar teste
                </button>
              )}
            </div>
          </section>
          <section className="quick-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-label">Histórico de teste</p>
                <h2>{(snapshot.routeDispatches || []).filter((route) => route.mode === "test" || ["warmup", "target-simulation"].includes(getRouteTrigger(route))).length} registro(s)</h2>
              </div>
              <button className="button" type="button" onClick={confirmSimulateTargetDispatch}>
                Simular alvo
              </button>
              <button className="button" disabled={busy || snapshot.status !== "connected"} type="button" onClick={() => runAction(botApi.latencyProbe)}>
                Medir latência
              </button>
            </div>
            <div className="admin-route-scroll compact">
              {(snapshot.routeDispatches || [])
                .filter((route) => route.mode === "test" || ["warmup", "target-simulation"].includes(getRouteTrigger(route)))
                .slice(0, 12)
                .map((route) => <RouteRow key={`client-test-${route.id}`} route={route} />)}
            </div>
          </section>
          <LogsPanel logs={snapshot.logs.filter((log) => /teste|aquecimento|simulação/i.test(log.message)).slice(0, 80)} />
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="tab-stack">
          <SettingsPanel
            config={snapshot.config}
            busy={busy}
            monitoringEnabled={Boolean(snapshot.monitoringEnabled)}
            userEmail={userEmail}
            onFactoryReset={confirmFactoryReset}
            onEnableNotifications={handleEnableNotifications}
            notificationStatus={notificationStatus}
            onLogout={() => {
              logout();
            }}
          />
        </section>
      ) : null}

      <nav className="bottom-nav icon-nav" aria-label="Navegação principal">
        {tabs.map(({ id, label, Icon }) => {
          const badge =
            id === "test" && snapshot.testStatus?.active
              ? 1
              : id === "settings" && snapshot.logs.some((log) => log.level === "error" && !isImageOperationLog(log.message))
              ? snapshot.logs.filter((log) => log.level === "error" && !isImageOperationLog(log.message)).length
              : 0;
          return (
            <button
              key={id}
              aria-label={label}
              className={activeTab === id ? "active" : ""}
              title={label}
              type="button"
              onClick={() => setActiveTab(id)}
            >
              {badge ? <b className="nav-badge">{badge}</b> : null}
              <Icon size={22} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {actionToast ? <div className={["action-toast", actionToast.tone ? `tone-${actionToast.tone}` : ""].filter(Boolean).join(" ")}>{actionToast.message}</div> : null}
      {releaseNotice ? (
        <ReleaseDialog
          release={releaseNotice}
          busy={releaseAcknowledgeBusy}
          error={releaseError}
          onAcknowledge={() => void handleAcknowledgeRelease()}
        />
      ) : null}
      {groupEditor ? (
        <div className="modal-backdrop" role="presentation">
          <section className="sheet-dialog" role="dialog" aria-modal="true" aria-labelledby="group-editor-title">
            <div className="sheet-heading">
              <div>
                <p className="panel-label">Configuração</p>
                <h2 id="group-editor-title">{groupEditor === "image" ? "Bot imagem" : groupEditor === "target" ? "Mensagens manuais" : "Teste abrir/fechar"}</h2>
              </div>
              <button className="icon-button" title="Fechar" type="button" onClick={() => setGroupEditor(undefined)}>
                <X size={20} />
              </button>
            </div>
            <GroupMessageCard
              kind={groupEditor === "image" ? "target" : groupEditor}
              targetMode={groupEditor === "image" ? "ocr" : "manual"}
              config={snapshot.config}
              groups={snapshot.groups}
              detectedRegions={detectedRegions}
              busy={busy}
              onRefresh={() => runAction(botApi.refreshGroups)}
              onSave={groupEditor === "target" || groupEditor === "image" ? confirmSaveTarget : confirmSaveTest}
              onSaveManual={undefined}
              onWarmup={groupEditor === "test" ? confirmWarmup : undefined}
            />
          </section>
        </div>
      ) : null}

      {confirmation ? (
        <div className="modal-backdrop" role="presentation">
          <section className={["confirmation-dialog", confirmation.tone ? `tone-${confirmation.tone}` : ""].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <p className="panel-label">Confirmação</p>
            <h2 id="confirm-title">{confirmation.title}</h2>
            <p className="confirmation-message">{confirmation.message}</p>
            {confirmation.details.length ? (
              <div className="confirmation-details">
                {confirmation.details.map((detail, index) => (
                  <span key={`${detail}-${index}`}>{detail}</span>
                ))}
              </div>
            ) : null}
            <div className="confirmation-actions">
              <button className="button" disabled={busy} type="button" onClick={() => setConfirmation(undefined)}>
                Cancelar
              </button>
              <button className="button primary" disabled={busy} type="button" onClick={confirmPendingAction}>
                {confirmation.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {automaticOcrAnalysisOpen && snapshot.config.targetDispatchMode === "ocr" ? (
        <AutomaticOcrAnalysisDialog
          selection={snapshot.ocrRouteSelection}
          onClose={() => {
            rememberAnalysisId(OCR_ANALYSIS_DISMISSED_KEY, snapshot.ocrRouteSelection?.analysisId);
            setAutomaticOcrAnalysisOpen(false);
          }}
          busy={busy}
          onConfirm={async (optionIds) => {
            await runAction(() => botApi.confirmOcrRoutes({ optionIds }));
          }}
        />
      ) : null}
      {historyOcrSelection ? (
        <AutomaticOcrAnalysisDialog selection={historyOcrSelection} onClose={() => setHistoryOcrSelection(undefined)} />
      ) : null}
      {pendingClientIncident ? (
        <div className="modal-backdrop incident-lock-backdrop" role="presentation">
          <section className="confirmation-dialog incident-lock-dialog" role="dialog" aria-modal="true" aria-labelledby="incident-lock-title">
            <p className="panel-label">Ação obrigatória</p>
            <h2 id="incident-lock-title">Explique o que aconteceu</h2>
            <p className="confirmation-message">
              {pendingClientIncident.clientIncident?.message || "O admin precisa de uma explicação para liberar o bot."}
            </p>
            <div className="incident-summary-grid">
              <span>
                <b>Evento</b>
                {pendingClientIncident.clientIncident?.kind === "message_deleted" ? "Mensagem apagada" : "Líder removeu reação"}
              </span>
              <span>
                <b>Prazo</b>
                {pendingClientIncident.clientIncident?.snoozeCount ? `${pendingClientIncident.clientIncident.snoozeCount}/3 adiamentos usados` : "Primeira cobrança"}
              </span>
            </div>
            <div className="confirmation-details incident-audit-list">
              {pendingIncidentAuditLines.map((line) => (
                <span key={`${pendingClientIncident.id}-${line}`}>{line}</span>
              ))}
            </div>
            <div className="incident-choice">
              <button className={incidentValid ? "button primary" : "button"} type="button" onClick={() => setIncidentValid(true)}>
                Rota válida
              </button>
              <button className={!incidentValid ? "button danger" : "button"} type="button" onClick={() => setIncidentValid(false)}>
                Rota não válida
              </button>
            </div>
            <textarea
              className="incident-textarea"
              autoFocus
              value={incidentReason}
              onChange={(event) => setIncidentReason(event.target.value)}
              placeholder="Descreva o motivo: por que a reação foi removida ou por que a mensagem foi apagada?"
            />
            <div className="confirmation-actions">
              {pendingIncidentSnoozeDelay ? (
                <button className="button incident-snooze-button" disabled={busy} type="button" onClick={snoozePendingClientIncident}>
                  <Clock3 size={16} />
                  Responder daqui a {pendingIncidentSnoozeDelay} minutos
                </button>
              ) : (
                <span className="incident-final-warning">Adiamentos encerrados. A resposta é obrigatória.</span>
              )}
              <button className="button primary" disabled={busy || incidentReason.trim().length < 8} type="button" onClick={submitIncidentAnswer}>
                Enviar explicação e liberar bot
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
