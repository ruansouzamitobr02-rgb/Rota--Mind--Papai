import { Boom } from "@hapi/boom";
import P from "pino";
import fs from "fs";
import path from "path";
import os from "os";
import { webcrypto } from "crypto";
import { EventEmitter } from "events";
import { ConfigStore, DEFAULT_CONFIG } from "./config";
import { resolveGroup, normalizarTexto } from "./group";
import { BotLogger } from "./logger";
import { combineRouteImageBatch, DetectedRouteCode, extractNeighborhoodAfterCity, findAllGaiolaCodesFromOcr, findAllPlannedAtCodesFromOcr, findNeighborhoodInOcrLine, isSafeAutomaticGaiolaDetection, reconcileGaiolaDetectionsWithRomaneio } from "./ocr";
import { readRouteImageOcrWithoutBlockingSocket, warmupIsolatedOcrWorker } from "./ocrIsolated";
import { canonicalConfiguredNeighborhood, findManualRouteCandidatesFromOcr, normalizeRegionIdentity, selectPreferredNeighborhoodFromOcr } from "./ocrNeighborhoodSelection";
import { isCentroNeighborhood } from "../shared/neighborhoodRegion";
import { createBoundedVersionLookup } from "./versionLookup";
import { DispatchQueueStore } from "./dispatchQueue";
import { OcrAnalysisHistoryStore } from "./ocrAnalysisHistoryStore";
import { RouteStore } from "./routeStore";
import { TelemetryStore } from "./telemetryStore";
import { useSqliteAuthState } from "./sqliteAuthState";
import { DEFAULT_LEADER_CONTACTS } from "./leaderDefaults";
import { RomaneioStore } from "../services/romaneio/romaneioStore";
import { isPreferredImageCity, PREFERRED_IMAGE_CITY, rankImageRouteOptions } from "../services/romaneio/rankImageRoutes";
import { BotConfig, BotGroup, BotGroupState, BotPerformanceMetrics, BotReadinessCheck, BotSnapshot, BotStatus, BotStatusEvent, BotTestStatus, DispatchPriorityProfile, LeaderContact, MonitoredRoute, OcrRouteOption, OcrRouteSelectionState, RomaneioCandidate, RomaneioLocateResult, RomaneioRankedRoute, RomaneioSnapshot, RouteDispatch, RouteDispatchTimeline, RouteOcrInsight, RouteReaction } from "../shared/types";

const originalConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (String(args[0] || "").startsWith("Closing session:")) return;
  originalConsoleLog(...args);
};

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
}

let makeWASocket: any;
let DisconnectReason: any;
let fetchLatestBaileysVersion: any;
let useMultiFileAuthState: any;
let generateMessageIDV2: any;
let generateWAMessageFromContent: any;
let downloadMediaMessage: any;
let Browsers: any;
let makeCacheableSignalKeyStore: any;
let BufferJSON: any;
let proto: any;
let baileysLoadPromise: Promise<void> | undefined;

function loadBaileys(): Promise<void> {
  if (baileysLoadPromise) return baileysLoadPromise;

  baileysLoadPromise = (async () => {
    const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    const baileys = await importModule("@whiskeysockets/baileys");
    makeWASocket = baileys.default || baileys;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    generateMessageIDV2 = baileys.generateMessageIDV2;
    generateWAMessageFromContent = baileys.generateWAMessageFromContent;
    downloadMediaMessage = baileys.downloadMediaMessage;
    Browsers = baileys.Browsers;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    BufferJSON = baileys.BufferJSON;
    proto = baileys.proto;
  })();

  return baileysLoadPromise;
}

const lookupWhatsAppVersion = createBoundedVersionLookup(async () => {
  const { version } = await fetchLatestBaileysVersion();
  return version;
});

export type BotServiceOptions = {
  authDir?: string;
  configPath?: string;
  routeStorePath?: string;
  dispatchQueuePath?: string;
  telemetryPath?: string;
  ocrAnalysisHistoryPath?: string;
  logStorePath?: string;
  romaneioDir?: string;
  clientEmail?: string;
  dispatchPriorityLevel?: number;
  adminPhoneNumbers?: string[];
  leaderContacts?: LeaderContact[];
  terminalMode?: boolean;
  initialCodes?: string[];
  autoClearInvalidSession?: boolean;
  deferSnapshotPayload?: boolean;
};

export type DispatchGateGrant = { token: string; waitedMs: number };
export type DispatchGateRequest = { clientEmail: string; groupKey: string; eventDetectedAt: number; eventKey?: string; targetDispatchMode?: "manual" | "ocr" };
export type DispatchRaceEventState = "processing" | "ready" | "unavailable";
export type DispatchRaceEvent = { clientEmail: string; groupKey: string; eventDetectedAt: number; eventKey: string; state: DispatchRaceEventState };

type MonitoringMode = "target" | "test";
type OpeningSignal = NonNullable<RouteDispatchTimeline["openingSignal"]>;

const MAX_RECONNECT_ATTEMPTS = 0;
const HIGH_PERFORMANCE_PROFILE = process.env.BOT_PERFORMANCE_PROFILE === "high"
  || (!process.env.BOT_PERFORMANCE_PROFILE && Boolean(process.env.RENDER));
const RECONNECT_DELAY_MS = 3500;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 25000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 300000;
const RACE_KEEP_ALIVE_INTERVAL_MS = HIGH_PERFORMANCE_PROFILE ? 5000 : 10000;
const FULL_METADATA_KEEP_ALIVE_INTERVAL_MS = (HIGH_PERFORMANCE_PROFILE ? 2 : 4) * 60 * 1000;
const CRYPTO_SESSION_KEEP_ALIVE_INTERVAL_MS = (HIGH_PERFORMANCE_PROFILE ? 1 : 5) * 60 * 1000;
const SENDER_KEY_KEEP_ALIVE_INTERVAL_MS = (HIGH_PERFORMANCE_PROFILE ? 1 : 5) * 60 * 1000;
const SOCKET_RTT_KEEP_ALIVE_INTERVAL_MS = (HIGH_PERFORMANCE_PROFILE ? 30 : 60) * 1000;
const ACTIVE_CHAT_KEEP_ALIVE_INTERVAL_MS = (HIGH_PERFORMANCE_PROFILE ? 30 : 60) * 1000;
const INTERNAL_WARM_READY_MAX_AGE_MS = (HIGH_PERFORMANCE_PROFILE ? 45 : 90) * 1000;
const INITIAL_INTERNAL_WARM_WAIT_MS = HIGH_PERFORMANCE_PROFILE ? 5000 : 2200;
const CRITICAL_KEEP_ALIVE_INTERVAL_MS = 5000;
const SOCKET_KEEP_ALIVE_INTERVAL_MS = 10000;
const SOCKET_CONNECT_TIMEOUT_MS = 15000;
const SOCKET_QUERY_TIMEOUT_MS = 15000;
export const QR_CODE_LIFETIME_MS = 60_000;
const ROMANEIO_CANDIDATE_LIMIT = 20;
const TARGET_ACK_TIMEOUT_MS = 1200;
// A primeira rota ganha acesso exclusivo ao socket; a segunda sai logo depois.
const TARGET_PARALLEL_STAGGER_MS = 4;
const MANUAL_ROUTE_SELECTION_STAGGER_MS = 0;
// O nível interno agora é binário e invisível: o cliente escolhido como perdedor
// cede esta janela somente quando o vencedor também concorre no mesmo grupo.
// Cada confronto aceita até 10s, mas cadeias com muitos clientes acumulam
// seus intervalos para preservar a ordem completa sem empatar no teto.
const MAX_DISPATCH_PRIORITY_DELAY_MS = 120_000;
const MAX_DISPATCH_PRIORITY_LEVEL = 5;
const MAX_OUTGOING_MESSAGES = 2;
const ROUTE_IMAGE_BATCH_QUIET_MS = 75;
const ROUTE_IMAGE_BATCH_MAX = 12;
const WARMUP_MESSAGE_COUNT = 15;
// Maior que o keep-alive crítico (5s), evitando reconstrução no exato evento de abertura.
const NOT_ACCEPTABLE_ALERT_THRESHOLD = 3;
const NOT_ACCEPTABLE_RETRY_DELAYS_MS = [25, 55, 90, 140, 220, 340, 520, 800, 1200, 1800, 2600, 3800];
const GENERIC_RETRY_DELAYS_MS = [80, 180, 360, 700, 1100];
const OPENING_TRIGGER_WORDS = [
  "abriu",
  "aberto",
  "liberado",
  "liberou",
  "pode mandar",
  "podem mandar",
  "grupo aberto"
].map((item) => normalizarTexto(item));

const CRITICAL_WINDOWS = [
  { start: "04:20", end: "08:00" },
  { start: "10:20", end: "14:00" }
];
export { DEFAULT_LEADER_CONTACTS } from "./leaderDefaults";

function triggerLabelForEvent(trigger: RouteDispatch["trigger"]) {
  if (trigger === "manual") return "Disparo manual";
  if (trigger === "warmup") return "Aquecimento";
  if (trigger === "target-simulation") return "Simulação do alvo";
  if (trigger === "simulation") return "Simulação de abertura";
  return "Disparo automático";
}

export class BotService extends EventEmitter {
  private sock: any;
  private status: BotStatus = "disconnected";
  private groupState: BotGroupState = "unknown";
  private qrCode = "";
  private qrGeneratedAt?: string;
  private qrExpiresAt?: string;
  private qrAttempt = 0;
  private error = "";
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private healthCheckTimer?: NodeJS.Timeout;
  private warmKeepAliveTimer?: NodeJS.Timeout;
  private closingWarmupTimer?: NodeJS.Timeout;
  private warmKeepAliveIntervalMs = 0;
  private stopping = false;
  private starting?: Promise<void>;
  private activeConnectionId = 0;
  private qrReceivedInCurrentConnection = false;
  private qrRefAttemptResets = 0;
  private unknownDisconnects = 0;
  private sendCycleId = 0;
  private activeSendCycle?: Promise<void>;
  private activeSendCycleId?: number;
  private activeSendTrigger?: RouteDispatch["trigger"];
  private criticalDispatchInProgress = false;
  private lastOpeningSignalAt = 0;
  private pendingReactionBatch?: any[];
  private reactionProcessingScheduled = false;
  private monitoringEnabled = false;
  private monitoringMode: MonitoringMode = "target";
  private estadoInicialDoGrupoCapturado = false;
  private grupoJaFechouDepoisDoInicio = false;
  private diagnosedNotAcceptableCycles = new Set<number>();
  private codigosEscolhidos: string[] = [];
  private mensagensProntasAlvo: string[] = [];
  private mensagensProntasTeste: string[] = [];
  private preparedTargetJid = "";
  private preparedMessages: string[] = [];
  private preparedRelayMessages: any[] = []; // esse aqui
  private preparedRelaySignature = "";
  private preparedRelayBuiltAt = 0;
  private preparedNuclearMode = false;
  private preparedTargetDispatchMode: BotConfig["targetDispatchMode"] = "manual";
  private pendingOcrMessages: string[] = [];
  private pendingOcrReconnectDispatch?: {
    analysisId?: string;
    trigger: "manual" | "automatic";
    interruptedCycleId?: number;
    queuedAt: string;
  };
  private acceptedMessageCountByCycle = new Map<number, number>();
  private lastOcrDispatchKey = "";
  private lastOcrInsight?: RouteOcrInsight;
  private ocrRouteSelection: OcrRouteSelectionState = { status: "idle", options: [] };
  private processingImageIds = new Set<string>();
  private pendingRouteImageBatch: Array<{ msg: any; groupJid: string; messageId: string }> = [];
  private routeImageBatchTimer?: NodeJS.Timeout;
  private routeImageBatchProcessing = false;
  private ocrAnalysisDurationsMs: number[] = [];
  private latestRouteImageSequence = 0;
  private warmupMessagesSent = 0;
  private warmupCompleted = false;
  private activeTestRunId = 0;
  private testStatus: BotTestStatus = {
    active: false,
    lastSentCount: 0,
    lastFailedCount: 0,
    configuredMessageCount: WARMUP_MESSAGE_COUNT,
    intervalMs: 0
  };
  private performanceMetrics: BotPerformanceMetrics = {
    lastDispatchLatencyMs: 0,
    averageDispatchLatencyMs: 0,
    lastDispatchDurationMs: 0,
    averageMessageSendMs: 0,
    dispatchCount: 0,
    sentMessages: 0,
    failedMessages: 0,
    activeQueue: 0
  };
  private configStore: ConfigStore;
  private routeStore: RouteStore;
  private dispatchQueueStore: DispatchQueueStore;
  private telemetryStore: TelemetryStore;
  private ocrAnalysisHistoryStore: OcrAnalysisHistoryStore;
  private romaneioStore?: RomaneioStore;
  private logger: BotLogger;
  private authDir: string;
  private statusEventsPath: string;
  private statusEvents: BotStatusEvent[] = [];
  private clientEmail = "";
  private dispatchPriorityLevel = 0;
  private dispatchPriorityDelayMs = 0;
  private dispatchGateRequester?: (request: DispatchGateRequest) => Promise<DispatchGateGrant>;
  private dispatchGateRelayReporter?: (token: string, clientEmail: string, relayedAt: number) => void;
  private dispatchGateFailureReporter?: (token: string, clientEmail: string, failedAt: number) => void;
  private dispatchRaceEventReporter?: (event: DispatchRaceEvent) => void;
  private adminPhoneNumbers = new Set<string>();
  private extraAdminPhoneNumbers: string[] = [];
  private leaderContacts = new Map<string, string>();
  private activeRouteByCycle = new Map<number, string>();
  private routeMessageIdsByCycle = new Map<number, string[]>();
  private outboundRaceTracking = new Map<string, { cycleId: number; timeline: RouteDispatchTimeline; relayCalledAt: number; routeId?: string }>();
  private dispatchQueueIdByCycle = new Map<number, string>();
  private pendingCredsSave?: NodeJS.Timeout;
  private credsSaveInFlight?: Promise<void>;
  private credsSaveDirty = false;
  private saveCredsNow?: () => Promise<void> | void;
  private flushAuthState?: () => Promise<void>;
  private closeAuthState?: () => Promise<void>;
  private destroyAuthState?: () => void;
  private authBackend: "sqlite" | "multi-file" = "multi-file";
  private targetSimulationCycles = new Set<number>();
  private autoClearInvalidSession = false;
  private clearedInvalidSessionInCurrentRun = false;
  private groupMetadataCache = new Map<string, any>();
  private socketAllowedGroupJids = new Set<string>();
  private currentUserInTargetGroup = false;
  private groups: BotGroup[] = [];
  private armedAt?: number;
  private lastKeepAliveAt?: string;
  private lastKeepAliveDurationMs = 0;
  private keepAliveCount = 0;
  private internalWarmState: "cold" | "warming" | "ready" = "cold";
  private lastInternalWarmAt?: string;
  private lastInternalWarmDurationMs = 0;
  private lastActiveChatWarmAt = 0;
  private consecutiveHealthCheckFailures = 0;
  private lastFullMetadataWarmAt = 0;
  private lastGroupCryptoWarmAt = 0;
  private lastGroupCryptoWarmDurationMs = 0;
  private warmedGroupDeviceCount = 0;
  private warmedGroupParticipantSignature = "";
  private lastSenderKeyWarmAt = 0;
  private lastSenderKeyWarmDurationMs = 0;
  private lastSocketRttAt = 0;
  private lastSocketRttMs?: number;
  private activeSignalProfileTimeline?: RouteDispatchTimeline;
  private groupCryptoWarmInFlight?: Promise<boolean>;
  private adaptiveOpeningSettleMs = 0;
  private lastNotAcceptableAlertAt = 0;
  private romaneioDocumentCandidates = new Map<string, { candidate: RomaneioCandidate; message: any }>();
  private processingRomaneioCandidateIds = new Set<string>();
  private latestAutomaticRomaneioTimestamp = 0;
  private readonly deferSnapshotPayload: boolean;

  constructor(options: BotServiceOptions = {}) {
    super();
    this.authDir = options.authDir || path.resolve(process.cwd(), "auth_info");
    this.deferSnapshotPayload = Boolean(options.deferSnapshotPayload);
    this.configStore = new ConfigStore(options.configPath);
    this.routeStore = new RouteStore(options.routeStorePath || path.resolve(process.cwd(), "route_history.json"));
    this.dispatchQueueStore = new DispatchQueueStore(options.dispatchQueuePath || path.resolve(process.cwd(), "dispatch_queue.json"));
    this.telemetryStore = new TelemetryStore(options.telemetryPath || path.resolve(process.cwd(), "dispatch_telemetry.json"));
    this.ocrAnalysisHistoryStore = new OcrAnalysisHistoryStore(options.ocrAnalysisHistoryPath || path.join(path.dirname(this.configStore.path), "ocr_analysis_history.json"));
    this.romaneioStore = options.romaneioDir ? new RomaneioStore(options.romaneioDir) : undefined;
    this.logger = new BotLogger(() => this.emitSnapshot(), options.logStorePath || path.resolve(process.cwd(), "bot_logs.json"));
    this.statusEventsPath = path.join(path.dirname(options.routeStorePath || path.resolve(process.cwd(), "route_history.json")), "status_events.json");
    this.statusEvents = this.loadStatusEvents();
    this.clientEmail = options.clientEmail || "";
    this.dispatchPriorityLevel = this.normalizeDispatchPriorityLevel(options.dispatchPriorityLevel);
    const initialLeaders = options.leaderContacts?.length ? options.leaderContacts : DEFAULT_LEADER_CONTACTS;
    this.extraAdminPhoneNumbers = (options.adminPhoneNumbers || []).map((item) => this.normalizePhone(item)).filter(Boolean);
    this.leaderContacts = new Map(initialLeaders.map((item) => [this.normalizePhone(item.phone), item.name]));
    this.adminPhoneNumbers = new Set([
      ...initialLeaders.map((item) => this.normalizePhone(item.phone)),
      ...this.extraAdminPhoneNumbers
    ].filter(Boolean));
    this.autoClearInvalidSession = Boolean(options.autoClearInvalidSession);
    const config = this.configStore.load();
    if (HIGH_PERFORMANCE_PROFILE && config.targetDispatchMode === "ocr") {
      // No plano dedicado, carregue o modelo antes de o cliente abrir o painel.
      // Assim a primeira imagem não paga o custo de iniciar processo e idioma.
      warmupIsolatedOcrWorker();
    }
    this.refreshRuntimeSettings(config);
    this.refreshSocketJidFilterCache(config);
    this.codigosEscolhidos = options.initialCodes?.length ? options.initialCodes : [];
    this.montarMensagens();
    this.warmupMessagesSent = 0;
    this.warmupCompleted = false;
  }

  getSnapshot(): BotSnapshot {
    const telemetry = this.telemetryStore.summary();
    return {
      status: this.status,
      groupState: this.groupState,
      qrCode: this.qrCode,
      qrGeneratedAt: this.qrGeneratedAt,
      qrExpiresAt: this.qrExpiresAt,
      qrAttempt: this.qrAttempt || undefined,
      config: this.configStore.load(),
      groups: this.groups,
      readinessChecks: this.getReadinessChecks(),
      logs: this.logger.all(),
      error: this.error,
      monitoringEnabled: this.monitoringEnabled,
      monitoringMode: this.monitoringEnabled ? this.monitoringMode : undefined,
      warmupCompleted: this.warmupCompleted,
      warmupMessagesSent: this.warmupMessagesSent,
      warmupRequiredMessages: this.configStore.load().testMessageCount || WARMUP_MESSAGE_COUNT,
      testStatus: this.getTestStatus(),
      performanceMetrics: {
        ...this.performanceMetrics,
        armedIdleMs: this.monitoringEnabled && this.armedAt ? Date.now() - this.armedAt : 0,
        lastKeepAliveAt: this.lastKeepAliveAt,
        lastKeepAliveDurationMs: this.lastKeepAliveDurationMs,
        keepAliveCount: this.keepAliveCount,
        internalWarmState: this.getCurrentInternalWarmState(),
        lastInternalWarmAt: this.lastInternalWarmAt,
        lastInternalWarmDurationMs: this.lastInternalWarmDurationMs,
        internalWarmAgeMs: this.getInternalWarmAgeMs(),
        lastGroupCryptoWarmDurationMs: this.lastGroupCryptoWarmDurationMs,
        warmedGroupDeviceCount: this.warmedGroupDeviceCount,
        lastSenderKeyWarmDurationMs: this.lastSenderKeyWarmDurationMs,
        authBackend: this.authBackend,
        socketRttMs: this.lastSocketRttMs,
        activeQueue: Math.max(this.performanceMetrics.activeQueue, this.dispatchQueueStore.pending().length),
        dispatchPriority: this.getDispatchPriorityProfile(),
        telemetryCount: telemetry.count,
        averageFirstRelayMs: telemetry.averageFirstRelayMs,
        p95FirstRelayMs: telemetry.p95FirstRelayMs,
        averageFirstAckMs: telemetry.averageFirstAckMs,
        p95FirstAckMs: telemetry.p95FirstAckMs,
        averageFirstGroupEchoMs: telemetry.averageFirstGroupEchoMs,
        p95FirstGroupEchoMs: telemetry.p95FirstGroupEchoMs,
        averageTotalDurationMs: telemetry.averageTotalDurationMs,
        p95TotalDurationMs: telemetry.p95TotalDurationMs,
        dispatchSuccessRate: telemetry.successRate,
        warmDispatchCount: telemetry.warmDispatchCount,
        coldDispatchCount: telemetry.coldDispatchCount,
        timeoutCount: telemetry.timeoutCount,
        retryCount: telemetry.retryCount,
        notAcceptableCount: telemetry.notAcceptableCount,
        lastNotAcceptableAt: telemetry.lastNotAcceptableAt,
        criticalWarmMode: this.isCriticalWarmWindow(),
        raceHealth: this.getRaceHealth(telemetry.p95FirstAckMs)
      },
      routeDispatches: this.getRoutes(),
      statusEvents: this.statusEvents,
      ocrRouteSelection: this.ocrRouteSelection,
      ocrAnalysisHistory: this.ocrAnalysisHistoryStore.all()
    };
  }

  getRoutes() {
    return this.routeStore.all();
  }

  getAnalysisPreview(id: string): string | undefined {
    const current = this.ocrRouteSelection;
    if (id === current.analysisId || id === current.processedAt) return current.imagePreviewUrl;
    const previous = this.ocrAnalysisHistoryStore.all().find((item) => id === item.analysisId || id === item.processedAt);
    if (previous?.imagePreviewUrl) return previous.imagePreviewUrl;
    return this.getRoutes().find((route) => route.id === id || route.ocr?.analysisId === id)?.ocr?.imagePreviewUrl;
  }

  setDispatchGateHandlers(
    requester?: (request: DispatchGateRequest) => Promise<DispatchGateGrant>,
    relayReporter?: (token: string, clientEmail: string, relayedAt: number) => void,
    failureReporter?: (token: string, clientEmail: string, failedAt: number) => void,
    eventReporter?: (event: DispatchRaceEvent) => void
  ) {
    this.dispatchGateRequester = requester;
    this.dispatchGateRelayReporter = relayReporter;
    this.dispatchGateFailureReporter = failureReporter;
    this.dispatchRaceEventReporter = eventReporter;
  }

  private refreshRuntimeSettings(config = this.configStore.load()) {
    this.testStatus.configuredMessageCount = config.testMessageCount || WARMUP_MESSAGE_COUNT;
    this.testStatus.intervalMs = config.testMessageIntervalMs || 0;
  }

  private getTestStatus(): BotTestStatus {
    this.refreshRuntimeSettings();
    return { ...this.testStatus };
  }

  private normalizeDispatchPriorityLevel(value: unknown) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return 0;
    return Math.min(MAX_DISPATCH_PRIORITY_LEVEL, Math.max(0, Math.floor(numberValue)));
  }

  private getDispatchPriorityProfile(): DispatchPriorityProfile {
    const legacyDelayMs = this.normalizeDispatchPriorityLevel(this.dispatchPriorityLevel) > 0 ? 400 : 0;
    const delayMs = Math.max(0, Math.min(MAX_DISPATCH_PRIORITY_DELAY_MS, Math.round(this.dispatchPriorityDelayMs || legacyDelayMs)));
    return {
      level: delayMs > 0 ? 1 : 0,
      delayMs
    };
  }

  private shouldApplyDispatchPriorityDelay(trigger: RouteDispatch["trigger"]) {
    return this.monitoringMode === "target" && (trigger === "automatic" || trigger === "manual");
  }

  private recordDispatchMetrics(input: {
    eventDetectedAt: number;
    sendStartedAt: number;
    sendFinishedAt: number;
    confirmed: number;
    total: number;
    timeline?: RouteDispatchTimeline;
    trigger?: RouteDispatch["trigger"];
    mode?: MonitoringMode;
  }) {
    const latency = Math.max(0, input.sendStartedAt - input.eventDetectedAt);
    const duration = Math.max(0, input.sendFinishedAt - input.sendStartedAt);
    const perMessage = input.total ? duration / input.total : duration;
    const nextCount = this.performanceMetrics.dispatchCount + 1;
    const average = (current: number, next: number) => Math.round(((current * this.performanceMetrics.dispatchCount) + next) / nextCount);

    this.performanceMetrics = {
      ...this.performanceMetrics,
      lastDispatchLatencyMs: latency,
      averageDispatchLatencyMs: average(this.performanceMetrics.averageDispatchLatencyMs, latency),
      lastDispatchDurationMs: duration,
      lastFirstRelayCallMs: input.timeline?.firstRelayCallMs,
      lastFirstAckMs: input.timeline?.firstAckMs,
      lastDispatchTimeline: input.timeline,
      lastDispatchWasWarm: input.timeline?.internalWarmState === "ready",
      averageMessageSendMs: average(this.performanceMetrics.averageMessageSendMs, perMessage),
      dispatchCount: nextCount,
      sentMessages: this.performanceMetrics.sentMessages + input.confirmed,
      failedMessages: this.performanceMetrics.failedMessages + Math.max(0, input.total - input.confirmed),
      activeQueue: 0,
      lastDispatchAt: new Date(input.sendFinishedAt).toISOString()
    };

    const event = this.telemetryStore.record({
      clientEmail: this.clientEmail,
      trigger: input.trigger,
      mode: input.mode || this.monitoringMode,
      confirmed: input.confirmed,
      total: input.total,
      timeline: input.timeline
    });
    this.maybeAlertNotAcceptable(event.notAcceptableCount);
  }

  private getInternalWarmAgeMs(now = Date.now()) {
    if (!this.lastInternalWarmAt) return undefined;
    const warmedAt = new Date(this.lastInternalWarmAt).getTime();
    if (!Number.isFinite(warmedAt)) return undefined;
    return Math.max(0, now - warmedAt);
  }

  private getCurrentInternalWarmState(now = Date.now()): "cold" | "warming" | "ready" {
    if (this.internalWarmState === "warming") return "warming";
    const ageMs = this.getInternalWarmAgeMs(now);
    if (
      this.internalWarmState === "ready" &&
      ageMs !== undefined &&
      ageMs <= INTERNAL_WARM_READY_MAX_AGE_MS &&
      this.status === "connected"
    ) {
      return "ready";
    }
    return "cold";
  }

  private profileSignalKeyStore(keys: any) {
    if (!keys) return keys;
    const profiled = {
      ...keys,
      get: async (type: string, ids: string[]) => {
        const startedAt = process.hrtime.bigint();
        try {
          return await keys.get(type, ids);
        } finally {
          this.recordSignalKeyTiming("read", startedAt);
        }
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        const startedAt = process.hrtime.bigint();
        try {
          return await keys.set(data);
        } finally {
          this.recordSignalKeyTiming("write", startedAt);
        }
      }
    };
    if (typeof keys.clear === "function") profiled.clear = () => keys.clear();
    return profiled;
  }

  private recordSignalKeyTiming(kind: "read" | "write", startedAt: bigint) {
    const timeline = this.activeSignalProfileTimeline;
    if (!timeline) return;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (kind === "read") {
      timeline.signalKeyReadMs = roundMetric((timeline.signalKeyReadMs || 0) + elapsedMs);
      timeline.signalKeyReadOps = (timeline.signalKeyReadOps || 0) + 1;
      return;
    }
    timeline.signalKeyWriteMs = roundMetric((timeline.signalKeyWriteMs || 0) + elapsedMs);
    timeline.signalKeyWriteOps = (timeline.signalKeyWriteOps || 0) + 1;
  }

  private createDispatchTimeline(eventDetectedAt: number, sendStartedAt: number, mode: RouteDispatchTimeline["mode"], openingSignal?: OpeningSignal): RouteDispatchTimeline {
    const internalWarmState = this.getCurrentInternalWarmState(sendStartedAt);
    const internalWarmAgeMs = this.getInternalWarmAgeMs(sendStartedAt);
    return {
      eventDetectedAt: new Date(eventDetectedAt).toISOString(),
      sendStartedAt: new Date(sendStartedAt).toISOString(),
      detectionDelayMs: Math.max(0, sendStartedAt - eventDetectedAt),
      timeoutUsed: false,
      retryUsed: false,
      notAcceptableCount: 0,
      mode,
      openingSignal,
      internalWarmState,
      internalWarmAgeMs,
      authBackend: this.authBackend,
      warmedDeviceCount: this.warmedGroupDeviceCount,
      socketRttMs: this.lastSocketRttMs,
      signalKeyReadMs: 0,
      signalKeyWriteMs: 0,
      signalKeyReadOps: 0,
      signalKeyWriteOps: 0,
      dispatchPriority: this.getDispatchPriorityProfile(),
      priorityDelayMs: 0,
      events: [
        {
          id: `event-${eventDetectedAt}`,
          label: "Evento detectado",
          at: new Date(eventDetectedAt).toISOString(),
          offsetMs: 0,
          level: "info",
          detail: openingSignal ? this.openingSignalLabel(openingSignal) : undefined
        },
        {
          id: `start-${sendStartedAt}`,
          label: "Disparo iniciado",
          at: new Date(sendStartedAt).toISOString(),
          offsetMs: Math.max(0, sendStartedAt - eventDetectedAt),
          level: "info",
          detail: internalWarmState === "ready"
            ? `Preparação interna aquecida há ${internalWarmAgeMs || 0}ms`
            : internalWarmState === "warming"
            ? "Preparação interna ainda em andamento"
            : "Preparação interna fria"
        }
      ]
    };
  }

  private openingSignalLabel(signal: OpeningSignal) {
    if (signal === "group_update") return "Evento oficial do grupo";
    if (signal === "opening_message") return "Mensagem de abertura";
    if (signal === "already_open") return "Grupo já estava aberto ao armar";
    if (signal === "image_ready") return "Imagem pronta com grupo aberto";
    if (signal === "manual") return "Comando manual do painel";
    return "Simulação";
  }

  private addTimelineEvent(
    timeline: RouteDispatchTimeline,
    label: string,
    at = Date.now(),
    level: "info" | "success" | "warning" | "error" = "info",
    detail?: string
  ) {
    const base = new Date(timeline.eventDetectedAt).getTime();
    timeline.events.push({
      id: `${label}-${at}-${timeline.events.length}`,
      label,
      at: new Date(at).toISOString(),
      offsetMs: Math.max(0, at - base),
      level,
      detail
    });
  }

  private enqueueDispatch(cycleId: number, jid: string, mensagens: string[], trigger: RouteDispatch["trigger"]) {
    const item = this.dispatchQueueStore.enqueue({
      id: `${this.clientEmail || "local"}-${Date.now()}-${cycleId}`,
      cycleId,
      clientEmail: this.clientEmail,
      jid,
      messages: mensagens,
      trigger,
      mode: this.monitoringMode
    });
    this.dispatchQueueIdByCycle.set(cycleId, item.id);
    return item.id;
  }

  private markQueuedDispatchSending(cycleId: number, routeId?: string) {
    const queueId = this.dispatchQueueIdByCycle.get(cycleId);
    if (!queueId) return;
    this.dispatchQueueStore.incrementAttempts(queueId);
    this.dispatchQueueStore.markSending(queueId, routeId);
  }

  private markQueuedDispatchFinished(cycleId: number, confirmedCount: number, totalCount: number, error?: string) {
    const queueId = this.dispatchQueueIdByCycle.get(cycleId);
    if (!queueId) return;
    const status = confirmedCount === totalCount ? "sent" : confirmedCount > 0 ? "partial" : "failed";
    this.dispatchQueueStore.markFinished(queueId, status, confirmedCount, error);
    this.dispatchQueueIdByCycle.delete(cycleId);
  }

  private markQueuedDispatchAbandoned(cycleId: number, error: string) {
    const queueId = this.dispatchQueueIdByCycle.get(cycleId);
    if (!queueId) return;
    this.dispatchQueueStore.markAbandoned(queueId, error);
    this.dispatchQueueIdByCycle.delete(cycleId);
  }

  private reportPendingDispatchesAfterBoot() {
    const pending = this.dispatchQueueStore.pending();
    if (!pending.length) return;

    const recent = pending.filter((item) => Date.now() - new Date(item.updatedAt).getTime() < 1000 * 60 * 5);
    const stale = pending.filter((item) => !recent.includes(item));

    for (const item of stale) {
      this.dispatchQueueStore.markAbandoned(item.id, "Pendência antiga abandonada ao reiniciar para evitar disparo duplicado.");
    }

    if (recent.length) {
      this.logger.warning(
        `Fila encontrou ${recent.length} disparo(s) recente(s) pendente(s) após reinício. Mantive travado para evitar duplicidade; confira o histórico antes de reenviar.`
      );
    }
  }

  private scheduleCredsSave() {
    if (!this.saveCredsNow) return;
    this.credsSaveDirty = true;
    if (this.pendingCredsSave) return;
    this.pendingCredsSave = setTimeout(() => {
      this.pendingCredsSave = undefined;
      void this.flushCreds().catch((error) => {
        this.logger.warning(`Falha ao salvar credenciais do WhatsApp: ${this.getErrorMessage(error)}`);
      });
    }, 300);
  }

  private async flushCreds() {
    if (this.pendingCredsSave) {
      clearTimeout(this.pendingCredsSave);
      this.pendingCredsSave = undefined;
    }
    if (this.credsSaveInFlight) {
      await this.credsSaveInFlight;
      if (this.credsSaveDirty) await this.flushCreds();
      return;
    }
    const saveCreds = this.saveCredsNow;
    if (!saveCreds) return;

    this.credsSaveDirty = false;
    const savePromise = Promise.resolve(saveCreds());
    this.credsSaveInFlight = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.credsSaveInFlight === savePromise) this.credsSaveInFlight = undefined;
    }
    if (this.credsSaveDirty) await this.flushCreds();
  }

  validateRoute(routeId: string, validatedBy: string) {
    const changed = this.routeStore.validate(routeId, validatedBy, { source: "admin_manual" });
    if (changed) this.emitSnapshot();
    return changed;
  }

  rejectRoute(routeId: string, rejectedBy: string, reason?: string) {
    const changed = this.routeStore.reject(routeId, rejectedBy, reason);
    if (changed) this.emitSnapshot();
    return changed;
  }

  hasPendingClientIncident() {
    return this.getPendingClientIncidentRoutes().length > 0;
  }

  getPendingClientIncidentRoutes() {
    return this.getRoutes().filter((route) => RouteStore.isClientIncidentDue(route));
  }

  submitClientIncident(routeId: string, valid: boolean, reason: string) {
    if (!reason.trim()) {
      this.logger.warning("Informe o motivo antes de liberar o bot.");
      return false;
    }
    const changed = this.routeStore.answerClientIncident(routeId, { valid, reason });
    if (changed) {
      this.logger.success(`Cliente respondeu incidente da rota: ${valid ? "rota válida" : "rota não válida"} - ${reason.trim()}`);
      this.emitSnapshot();
    }
    return changed;
  }

  snoozeClientIncident(routeId: string) {
    const result = this.routeStore.snoozeClientIncident(routeId);
    if (result.ok) {
      this.logger.warning(`Cliente adiou a explicação do incidente por ${result.delayMinutes} minuto(s). Próxima cobrança: ${new Date(result.nextDueAt || Date.now()).toLocaleString("pt-BR")}.`);
      this.emitSnapshot();
      return true;
    }
    if (result.exhausted) {
      this.logger.warning("Cliente já usou todos os adiamentos do incidente. A resposta agora é obrigatória.");
    }
    return false;
  }

  setLeaderContacts(contacts: LeaderContact[]) {
    const normalized = contacts
      .map((item) => ({
        name: String(item.name || "").trim(),
        phone: this.normalizePhone(String(item.phone || ""))
      }))
      .filter((item) => item.name && item.phone);
    this.leaderContacts = new Map(normalized.map((item) => [item.phone, item.name]));
    this.adminPhoneNumbers = new Set([
      ...this.extraAdminPhoneNumbers,
      ...normalized.map((item) => item.phone)
    ].filter(Boolean));
    this.logger.success("Lista de líderes de reação atualizada.");
    this.emitSnapshot();
  }
  isMonitoringEnabled(): boolean {
    return this.monitoringEnabled;
  }

  async enableMonitoring(): Promise<boolean> {
    return this.enableTargetMonitoring(false, "manual");
  }

  async enableImageMonitoring(): Promise<boolean> {
    const config = this.configStore.load();
    if (!config.nomeEnvio.trim()) {
      this.logger.warning("Configure o nome de envio antes de iniciar a IA.");
      this.emitSnapshot();
      return false;
    }
    return this.enableTargetMonitoring(false, "ocr");
  }

  async enableNuclearMonitoring(): Promise<boolean> {
    return this.enableTargetMonitoring(true, "manual");
  }

  private async enableTargetMonitoring(useNuclearMode: boolean, targetDispatchMode: BotConfig["targetDispatchMode"]): Promise<boolean> {
    if (this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de ativar o monitoramento.");
      return false;
    }

    this.monitoringMode = "target";
    const modeLabel = targetDispatchMode === "ocr" ? "bot imagem" : useNuclearMode ? "modo nuclear" : "bot manual";
    const config = this.configStore.save({ nuclearMode: useNuclearMode, targetDispatchMode });
    this.refreshSocketJidFilterCache(config);
    this.pendingOcrMessages = [];
    this.pendingOcrReconnectDispatch = undefined;
    this.acceptedMessageCountByCycle.clear();
    this.resetOcrRouteSelection();
    this.lastOcrDispatchKey = "";
    this.cancelPendingRouteImageBatch();
    if (targetDispatchMode === "ocr") warmupIsolatedOcrWorker();
    this.logger.info(`Modo ${modeLabel} selecionado. Os outros modos ficarão desligados.`);

    if (!this.hasReadyMessages()) {
      this.monitoringEnabled = false;
      this.logger.error("Bot não armado: existe verificação pendente na checklist de prontidão.");
      this.emitSnapshot();
      return false;
    }

    if (!this.prepareSendPlan()) {
      this.monitoringEnabled = false;
      this.logger.error("Bot não armado: não consegui preparar o plano de disparo.");
      this.emitSnapshot();
      return false;
    }

    await this.captureInitialGroupState();
    this.monitoringEnabled = true;
    this.armedAt = Date.now();
    this.addStatusEvent("armed", `Bot armado em modo ${modeLabel}.`);
    this.startHealthCheck();
    const initialWarmup = this.startWarmKeepAlive("armado");
    if (this.groupState !== "open") {
      await this.waitForInitialInternalWarmup(initialWarmup);
    }
    this.logger.success(targetDispatchMode === "ocr" ? "✅ BOT IMAGEM ARMADO. Aguardando foto da rota..." : useNuclearMode ? "✅ Bot NUCLEAR ARMADO. Aguardando abertura do grupo..." : "✅ Bot MANUAL ARMADO. Aguardando abertura do grupo...");
    this.dispatchIfGroupAlreadyOpen("armado");
    this.emitSnapshot();
    return true;
  }

  async enableTestMonitoring(): Promise<boolean> {
    if (this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de ativar o monitoramento de teste.");
      return false;
    }

    const config = this.configStore.load();
    if (!config.grupoTesteJid && !config.grupoTesteNome) {
      this.logger.warning("Salve um grupo de teste antes de ativar o monitoramento de teste.");
      return false;
    }

    const testGroup = await this.resolveWarmupTarget(config);
    if (!testGroup?.jid) {
      this.logger.warning("Não foi possível resolver o grupo de teste para monitorar abertura e fechamento.");
      return false;
    }

    const nextConfig = testGroup.jid !== config.grupoTesteJid
      ? this.configStore.saveTestGroupById(testGroup.jid, config.grupoTesteNome || "Grupo teste")
      : config;

    this.monitoringMode = "test";
    this.refreshSocketJidFilterCache(this.configStore.save({ ...nextConfig, nuclearMode: false }));

    if (!this.hasReadyMessages("test")) {
      this.monitoringEnabled = false;
      this.logger.error("Monitoramento de teste não armado: salve as mensagens do grupo de teste.");
      this.emitSnapshot();
      return false;
    }

    if (!this.prepareSendPlan()) {
      this.monitoringEnabled = false;
      this.logger.error("Monitoramento de teste não armado: não consegui preparar as mensagens de teste.");
      this.emitSnapshot();
      return false;
    }

    await this.captureInitialGroupState();
    this.monitoringEnabled = true;
    this.armedAt = Date.now();
    this.addStatusEvent("armed", "Bot de teste armado.");
    this.startHealthCheck();
    void this.startWarmKeepAlive("armado");
    this.logger.success("✅ TESTE ARMADO - O grupo de teste será ouvido como grupo real.");
    this.emitSnapshot();
    return true;
  }

  disableMonitoring(): void {
    this.monitoringEnabled = false;
    this.monitoringMode = "target";
    this.cancelPendingRouteImageBatch();
    this.invalidateInternalWarmState();
    this.refreshSocketJidFilterCache();
    this.armedAt = undefined;
    this.sendCycleId += 1;
    this.activeSendCycle = undefined;
    this.activeSendCycleId = undefined;
    this.activeSendTrigger = undefined;
    this.criticalDispatchInProgress = false;
    this.pendingOcrReconnectDispatch = undefined;
    this.acceptedMessageCountByCycle.clear();
    this.activeTestRunId += 1;
    if (this.testStatus.active) {
      this.testStatus = {
        ...this.getTestStatus(),
        active: false,
        startedAt: this.testStatus.startedAt,
        stoppedAt: new Date().toISOString(),
        lastRunAt: this.testStatus.lastRunAt,
        lastDurationMs: this.testStatus.startedAt ? Date.now() - new Date(this.testStatus.startedAt).getTime() : undefined,
        lastSentCount: this.warmupMessagesSent,
        lastFailedCount: Math.max(0, this.testStatus.configuredMessageCount - this.warmupMessagesSent)
      };
      this.logger.warning("Teste interrompido pelo painel do usuário.");
    }
    this.clearHealthCheckTimer();
    this.clearWarmKeepAliveTimer();
    this.logger.info("⏹️ Monitoramento desativado (Parou de escutar aberturas).");
    this.addStatusEvent("disarmed", "Monitoramento desativado pelo painel.");
    this.emitSnapshot();
  }

  simulateOpening(): boolean {
    if (this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de simular abertura.");
      this.emitSnapshot();
      return false;
    }

    this.monitoringMode = "target";
    this.refreshSocketJidFilterCache();

    if (!this.prepareSendPlan()) {
      this.logger.error("Simulação cancelada: não consegui preparar o plano de disparo.");
      this.emitSnapshot();
      return false;
    }

    const cycleId = ++this.sendCycleId;
    this.groupState = "open";
    this.grupoJaFechouDepoisDoInicio = false;
    this.logger.warning("Simulação de abertura acionada pelo painel.");
    this.enviarMensagensRapidas(cycleId, "simulation", Date.now(), "simulation");
    this.logger.info("⚡ Abertura simulada. Disparo acionado.");
    this.emitSnapshot();
    return true;
  }

  async manualDispatch(): Promise<boolean> {
    if (this.status !== "connected" || !this.sock) {
      this.logger.warning("Conecte o WhatsApp antes de disparar manualmente.");
      this.emitSnapshot();
      return false;
    }

    this.monitoringMode = "target";
    this.refreshSocketJidFilterCache();
    if (!this.configStore.load().grupoAlvoJid && this.configStore.load().grupoAlvoNome) {
      await this.resolveConfiguredGroup();
    }

    const config = this.configStore.load();
    const targetJid = config.grupoAlvoJid;

    if (!targetJid) {
      this.logger.error("Grupo alvo ainda não foi configurado.");
      this.emitSnapshot();
      return false;
    }

    // O clique manual não pode pular a preparação criptográfica. Em grupos
    // grandes, disparar frio faz o relay gastar segundos criando sessões e
    // gravando chaves antes de alcançar o socket.
    if (this.getCurrentInternalWarmState() !== "ready") {
      this.logger.info("Preparando criptografia do grupo antes do disparo manual...");
      const warmed = await this.runWarmKeepAlive("armado");
      if (!warmed || this.getCurrentInternalWarmState() !== "ready") {
        this.logger.warning("Disparo manual aguardando preparação interna. Tente novamente quando o painel indicar conexão aquecida.");
        this.emitSnapshot();
        return false;
      }
    }

    try {
      const metadata = await this.refreshGroupMetadata(targetJid);
      this.groupState = metadata?.announce === false ? "open" : "closed";
    } catch (error) {
      this.logger.warning(`Não consegui confirmar o estado do grupo: ${this.getErrorMessage(error)}`);
    }

    if (this.groupState !== "open") {
      this.logger.error("Disparo manual bloqueado: o grupo ainda está fechado.");
      this.emitSnapshot();
      return false;
    }

    if (!this.prepareSendPlan()) {
      this.logger.error("Disparo manual cancelado: não consegui preparar as mensagens.");
      this.emitSnapshot();
      return false;
    }

    const cycleId = ++this.sendCycleId;
    this.grupoJaFechouDepoisDoInicio = false;
    this.enviarMensagensRapidas(cycleId, "manual", Date.now(), "manual");
    this.logger.info("Disparo manual acionado pelo painel.");
    this.emitSnapshot();
    return true;
  }

  async simulateTargetDispatchOnTestGroup(): Promise<boolean> {
    if (!this.sock || this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de simular o disparo alvo.");
      return false;
    }

    const config = this.configStore.load();
    if (!config.grupoTesteJid && !config.grupoTesteNome) {
      this.logger.warning("Salve um grupo de teste antes de simular o disparo alvo.");
      return false;
    }

    this.syncMessagesFromConfig();
    let mensagens = [...this.mensagensProntasAlvo];
    if (!mensagens.length) {
      this.logger.warning("Configure as mensagens do grupo alvo antes de simular.");
      return false;
    }

    if (mensagens.length > MAX_OUTGOING_MESSAGES) {
      mensagens = mensagens.slice(0, MAX_OUTGOING_MESSAGES);
    }

    const testGroup = await this.resolveWarmupTarget(config);
    if (!testGroup?.jid) {
      this.logger.warning("Não foi possível resolver o grupo de teste para simular o alvo.");
      return false;
    }

    const cycleId = ++this.sendCycleId;
    this.targetSimulationCycles.add(cycleId);
    this.monitoringMode = "test";
    this.preparedTargetJid = testGroup.jid;
    this.preparedMessages = mensagens;
    this.rebuildPreparedRelayMessages(testGroup.jid, mensagens);
    this.registerRouteDispatch(cycleId, testGroup.jid, mensagens, "target-simulation");

    this.performanceMetrics.activeQueue = mensagens.length;
    const eventDetectedAt = Date.now();
    const sendCycle = this.sendFastSequence(testGroup.jid, mensagens, cycleId, eventDetectedAt, eventDetectedAt).finally(() => {
      this.targetSimulationCycles.delete(cycleId);
      if (cycleId === this.sendCycleId) this.activeSendCycle = undefined;
    });
    this.activeSendCycle = sendCycle;
    this.logger.info(`Simulação do alvo enviada no grupo de teste: ${mensagens.join(" | ")}`);
    this.emitSnapshot();
    return true;
  }

  async runLatencyProbeOnTestGroup(): Promise<boolean> {
    if (!this.sock || this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de medir latência.");
      return false;
    }

    const config = this.configStore.load();
    if (!config.grupoTesteJid && !config.grupoTesteNome) {
      this.logger.warning("Salve um grupo de teste antes de medir latência.");
      return false;
    }

    const testGroup = await this.resolveWarmupTarget(config);
    if (!testGroup?.jid) {
      this.logger.warning("Não foi possível resolver o grupo de teste para medir latência.");
      return false;
    }

    const previousMode = this.monitoringMode;
    const previousTargetJid = this.preparedTargetJid;
    const previousMessages = [...this.preparedMessages];
    const previousRelayMessages = [...this.preparedRelayMessages];
    const previousRelaySignature = this.preparedRelaySignature;
    const previousRelayBuiltAt = this.preparedRelayBuiltAt;

    const cycleId = ++this.sendCycleId;
    const eventDetectedAt = Date.now();
    const message = `Teste latencia ${new Date(eventDetectedAt).toLocaleTimeString("pt-BR", { hour12: false })}`;
    this.targetSimulationCycles.add(cycleId);
    this.monitoringMode = "test";
    this.refreshSocketJidFilterCache();
    this.preparedTargetJid = testGroup.jid;
    this.preparedMessages = [message];
    this.rebuildPreparedRelayMessages(testGroup.jid, [message]);
    this.enqueueDispatch(cycleId, testGroup.jid, [message], "simulation");
    const routeId = this.registerRouteDispatch(cycleId, testGroup.jid, [message], "simulation");
    this.markQueuedDispatchSending(cycleId, routeId);
    this.performanceMetrics.activeQueue = 1;

    const sendCycle = this.sendFastSequence(testGroup.jid, [message], cycleId, eventDetectedAt, eventDetectedAt, "simulation").finally(() => {
      this.targetSimulationCycles.delete(cycleId);
      if (cycleId === this.sendCycleId) this.activeSendCycle = undefined;
      this.monitoringMode = previousMode;
      this.refreshSocketJidFilterCache();
      this.preparedTargetJid = previousTargetJid;
      this.preparedMessages = previousMessages;
      this.preparedRelayMessages = previousRelayMessages;
      this.preparedRelaySignature = previousRelaySignature;
      this.preparedRelayBuiltAt = previousRelayBuiltAt;
    });

    this.activeSendCycle = sendCycle;
    this.logger.info(`Teste de latência enviado no grupo de teste: ${testGroup.jid}`);
    this.emitSnapshot();
    return true;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.isRunning()) {
      this.logger.warning("WhatsApp já está em processo de conexão ou conectado.");
      return;
    }

    this.stopping = false;
    this.reconnectAttempts = 0;
    this.qrRefAttemptResets = 0;
    this.clearedInvalidSessionInCurrentRun = false;
    this.starting = this.connect();

    try {
      await this.starting;
    } catch (error) {
      this.error = this.getErrorMessage(error);
      this.setStatus("error");
      this.logger.error(this.error);
    } finally {
      this.starting = undefined;
    }
  }

  async stop() {
    this.monitoringEnabled = false;
    this.monitoringMode = "target";
    this.stopping = true;
    this.sendCycleId += 1;
    this.activeTestRunId += 1;
    this.activeConnectionId += 1;
    this.clearReconnectTimer();
    this.clearHealthCheckTimer();
    this.clearWarmKeepAliveTimer();
    this.reconnectAttempts = 0;
    this.clearQrCode();

    await this.flushCreds().catch((error) => {
      this.logger.warning(`Não consegui salvar credenciais antes de parar: ${this.getErrorMessage(error)}`);
    });
    await this.flushAuthState?.().catch((error) => {
      this.logger.warning(`Não consegui concluir o espelho da sessão: ${this.getErrorMessage(error)}`);
    });
    const persistenceErrors: unknown[] = [];
    for (const persist of [() => this.routeStore.flush(), () => this.dispatchQueueStore.flush(), () => this.telemetryStore.flush(), () => this.ocrAnalysisHistoryStore.flush()]) {
      try { await persist(); } catch (error) { persistenceErrors.push(error); }
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners("creds.update");
        this.sock.ev.removeAllListeners("connection.update");
        this.sock.ev.removeAllListeners("groups.update");
        this.sock.ev.removeAllListeners("group-participants.update");
        this.sock.ev.removeAllListeners("messages.upsert");
        this.sock.ev.removeAllListeners("messages.update");
        this.sock.ev.removeAllListeners("messaging-history.set");
        this.sock.end?.(undefined);
        this.sock.ws?.close?.();
      } catch (error) {
        this.logger.warning(`Falha ao encerrar conexão antiga: ${this.getErrorMessage(error)}`);
      }
    }

    this.sock = undefined;
    await this.closeAuthState?.().catch(() => undefined);
    this.closeAuthState = undefined;
    this.flushAuthState = undefined;
    this.destroyAuthState = undefined;
    this.invalidateInternalWarmState();
    this.groupState = "unknown";
    this.currentUserInTargetGroup = false;
    this.criticalDispatchInProgress = false;
    this.activeSendCycle = undefined;
    this.activeSendCycleId = undefined;
    this.activeSendTrigger = undefined;
    this.pendingReactionBatch = undefined;
    this.reactionProcessingScheduled = false;
    this.pendingOcrMessages = [];
    this.pendingOcrReconnectDispatch = undefined;
    this.acceptedMessageCountByCycle.clear();
    this.resetOcrRouteSelection();
    this.cancelPendingRouteImageBatch();
    this.processingImageIds.clear();
    this.dispatchQueueIdByCycle.clear();
    this.preparedTargetJid = "";
    this.preparedMessages = [];
    this.preparedRelayMessages = []; // esse aqui
    this.preparedRelaySignature = "";
    this.preparedRelayBuiltAt = 0;
    this.setStatus("disconnected");
    this.logger.info("Bot parado.");
    try { await this.logger.flush(); } catch (error) { persistenceErrors.push(error); }
    if (persistenceErrors.length) throw new Error("Bot parado, mas houve falha ao persistir os dados. Verifique o armazenamento.");
  }

  async shutdownAndClearSession() {
    await this.stop();

    this.clearQrCode();
    this.error = "";
    this.logger.info("Bot encerrado. Sessão/auth preservada para a próxima abertura.");
    this.emitSnapshot();
    await this.logger.flush();
  }

  async restart() {
    if (!this.isRunning()) {
      this.logger.warning("Não há conexão ativa para reiniciar. Use Conectar WhatsApp.");
      return;
    }

    const shouldRestoreMonitoring = this.monitoringEnabled;
    this.logger.info("Reiniciando conexão...");
    await this.stop();
    this.monitoringEnabled = shouldRestoreMonitoring;
    await this.start();
  }

  async clearSession() {
    await this.logoutAndClearSession();
    this.clearQrCode();
    this.error = "";
    this.logger.warning("Sessão/auth apagada e logout solicitado. Gerando um novo QR Code.");
    this.emitSnapshot();
    await this.start();
  }

  async refreshQrCode() {
    if (this.status === "connected" || this.sock?.authState?.creds?.registered) {
      throw new Error("O WhatsApp já está conectado.");
    }
    if (this.isRunning()) await this.stop();
    this.clearPendingCredsSave();
    this.removeAuthDir();
    this.clearQrCode();
    this.error = "";
    this.reconnectAttempts = 0;
    this.unknownDisconnects = 0;
    this.logger.info("Gerando um QR Code novo e descartando tentativas expiradas.");
    await this.start();
  }

  async factoryReset() {
    this.logger.warning("Restaurando padrão de fábrica: limpando sessão, configurações e cache local.");

    if (this.isRunning()) {
      await this.stop();
    } else {
      this.monitoringEnabled = false;
      this.clearReconnectTimer();
      this.clearHealthCheckTimer();
      this.clearWarmKeepAliveTimer();
    }

    this.removeAuthDir();
    try {
      if (fs.existsSync(this.configStore.path)) {
        fs.rmSync(this.configStore.path, { force: true });
      }
    } catch (error) {
      this.logger.warning(`Falha ao apagar configuração: ${this.getErrorMessage(error)}`);
    }

    this.configStore.save(DEFAULT_CONFIG);
    this.refreshSocketJidFilterCache(DEFAULT_CONFIG);
    this.groupState = "unknown";
    this.clearQrCode();
    this.error = "";
    this.reconnectAttempts = 0;
    this.unknownDisconnects = 0;
    this.sendCycleId += 1;
    this.monitoringEnabled = false;
    this.criticalDispatchInProgress = false;
    this.activeSendCycle = undefined;
    this.activeSendCycleId = undefined;
    this.activeSendTrigger = undefined;
    this.pendingReactionBatch = undefined;
    this.reactionProcessingScheduled = false;
    this.pendingOcrMessages = [];
    this.pendingOcrReconnectDispatch = undefined;
    this.acceptedMessageCountByCycle.clear();
    this.resetOcrRouteSelection();
    this.lastOcrDispatchKey = "";
    this.cancelPendingRouteImageBatch();
    this.processingImageIds.clear();
    this.estadoInicialDoGrupoCapturado = false;
    this.grupoJaFechouDepoisDoInicio = false;
    this.currentUserInTargetGroup = false;
    this.groups = [];
    this.groupMetadataCache.clear();
    this.dispatchQueueIdByCycle.clear();
    this.dispatchQueueStore.clear();
    this.preparedTargetJid = "";
    this.preparedMessages = [];
    this.preparedRelayMessages = [];
    this.preparedRelaySignature = "";
    this.preparedRelayBuiltAt = 0;
    this.resetWarmupState();
    this.codigosEscolhidos = [];
    this.montarMensagens();
    this.logger.success("Padrão de fábrica aplicado. Gerando novo QR Code.");
    this.emitSnapshot();
    await this.start();
  }

  async saveGroup(group: string, groupId?: string, groupName?: string) {
    const config = groupId
      ? this.configStore.saveGroupById(groupId, groupName || group)
      : this.configStore.saveGroup(group);
    this.refreshSocketJidFilterCache(config);
    this.groupState = "unknown";
    this.currentUserInTargetGroup = false;
    this.preparedTargetJid = "";
    this.preparedMessages = [];
    this.preparedRelayMessages = [];
    this.preparedRelaySignature = "";
    this.preparedRelayBuiltAt = 0;
    this.invalidateInternalWarmState(true);
    this.pendingOcrMessages = [];
    this.resetOcrRouteSelection();
    this.lastOcrDispatchKey = "";
    this.cancelPendingRouteImageBatch();
    this.logger.success(`Grupo alterado para: ${config.grupoAlvoNome || config.grupoAlvoJid}`);

    if (this.sock && this.status === "connected") {
      await this.resolveConfiguredGroup();
    }
    // O grupo pode ser trocado pouco antes de um disparo manual. Aquece em
    // segundo plano mesmo com o monitoramento parado para não iniciar frio.
    void this.startWarmKeepAlive("armado");

    this.emitSnapshot();
  }

  async saveTestGroup(group: string, groupId?: string, groupName?: string) {
    this.resetWarmupState();
    const config = groupId
      ? this.configStore.saveTestGroupById(groupId, groupName || group)
      : this.configStore.saveTestGroup(group);
    this.refreshSocketJidFilterCache(config);
    if (this.monitoringEnabled && this.monitoringMode === "test") {
      void this.startWarmKeepAlive("armado");
    }
    this.logger.success(`Grupo de teste salvo: ${config.grupoTesteNome || config.grupoTesteJid}`);
    this.emitSnapshot();
  }

  async warmupConnection(message?: string): Promise<boolean> {
    if (!this.sock || this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de aquecer o bot.");
      return false;
    }

    const config = this.configStore.load();
    this.refreshRuntimeSettings(config);
    if (!config.grupoTesteJid && !config.grupoTesteNome) {
      this.logger.warning("Salve um grupo de teste para aquecimento antes de iniciar.");
      return false;
    }

    if (message) this.logger.info(message);

    const warmupGroup = await this.resolveWarmupTarget(config);
    if (!warmupGroup) {
      this.logger.warning("Não foi possível resolver o grupo de teste para aquecimento.");
      return false;
    }

    // ensure warmup messages are loaded from config
    this.syncMessagesFromConfig();

    const warmupMessages = this.buildWarmupMessages();
    const testRunId = ++this.activeTestRunId;
    this.warmupMessagesSent = 0;
    this.warmupCompleted = false;
    this.testStatus = {
      ...this.getTestStatus(),
      active: true,
      startedAt: new Date().toISOString(),
      stoppedAt: undefined,
      lastRunAt: new Date().toISOString(),
      lastSentCount: 0,
      lastFailedCount: 0
    };
    const testStartedAt = Date.now();
    this.emitSnapshot();

    // send an initial marker message indicating the start of warmup with weekday, date and time
    try {
      const now = new Date();
      const timestamp = now.toLocaleString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
      const initialMsg = `INICIANDO AQUECIMENTO 🔽 ${timestamp}`;
      await this.relayTextMessage(this.sock, warmupGroup.jid, initialMsg);
      this.logger.info("Mensagem inicial de aquecimento enviada.");
    } catch (err) {
      this.logger.warning(`Falha ao enviar mensagem inicial de aquecimento: ${this.getErrorMessage(err)}`);
    }

    // send warmup messages as fast as possible using low-level relay messages
    const relayMessages = warmupMessages.map((mensagem) => this.buildRelayTextMessage(this.sock, warmupGroup.jid, mensagem));

    for (const [index, fullMessage] of relayMessages.entries()) {
      if (testRunId !== this.activeTestRunId) break;
      const messageNumber = index + 1;
      this.logger.info(`Enviando mensagem de teste ${messageNumber}/${warmupMessages.length} para o grupo de teste.`);
      try {
        await this.relayPreparedMessage(this.sock, warmupGroup.jid, fullMessage);
        this.warmupMessagesSent += 1;
        this.logger.success(`Teste ${messageNumber} enviado.`);
      } catch (err) {
        this.testStatus.lastFailedCount += 1;
        this.logger.warning(`Falha no envio de teste ${messageNumber}: ${this.getErrorMessage(err)}. Continuando...`);
      }

      this.testStatus.lastSentCount = this.warmupMessagesSent;
      if (config.testMessageIntervalMs > 0 && messageNumber < relayMessages.length && testRunId === this.activeTestRunId) {
        await this.delay(config.testMessageIntervalMs);
      }
    }

    if (config.grupoAlvoJid) {
      await this.refreshGroupMetadata(config.grupoAlvoJid);
    }

    const stoppedByUser = testRunId !== this.activeTestRunId;
    this.warmupCompleted = !stoppedByUser && this.warmupMessagesSent >= warmupMessages.length;
    this.testStatus = {
      ...this.getTestStatus(),
      active: false,
      startedAt: this.testStatus.startedAt,
      stoppedAt: new Date().toISOString(),
      lastRunAt: this.testStatus.lastRunAt,
      lastDurationMs: Date.now() - testStartedAt,
      lastSentCount: this.warmupMessagesSent,
      lastFailedCount: Math.max(0, warmupMessages.length - this.warmupMessagesSent)
    };
    if (this.warmupCompleted) {
      this.logger.success(`Teste concluído: ${this.warmupMessagesSent}/${warmupMessages.length} mensagens enviadas no grupo de teste.`);
    } else if (stoppedByUser) {
      this.logger.warning(`Teste parado: ${this.warmupMessagesSent}/${warmupMessages.length} mensagens enviadas.`);
    } else {
      this.logger.warning(`Teste incompleto: ${this.warmupMessagesSent}/${warmupMessages.length} mensagens enviadas.`);
    }

    this.emitSnapshot();
    return this.warmupCompleted;
  }

  private async resolveWarmupTarget(config: BotConfig) {
    try {
      const resolved = await resolveGroup(this.sock, {
        jid: config.grupoTesteJid,
        name: config.grupoTesteNome
      });

      if (resolved.jid) {
        return { jid: resolved.jid, label: "grupo de teste" };
      }
    } catch (error) {
      this.logger.warning(`Não consegui resolver o grupo de teste: ${this.getErrorMessage(error)}`);
    }

    return undefined;
  }

  private buildWarmupMessages() {
    const config = this.configStore.load();
    const count = config.testMessageCount || WARMUP_MESSAGE_COUNT;
    const baseMessages = this.mensagensProntasTeste.length
      ? this.mensagensProntasTeste
      : ["Aquecimento"].map((item) => item);

    return Array.from({ length: count }, (_, index) => {
      const message = baseMessages[index % baseMessages.length];
      return `${message} (aquecimento ${index + 1})`;
    });
  }

  private getActiveMonitoringGroup(config = this.configStore.load()) {
    if (this.monitoringMode === "test") {
      return {
        jid: config.grupoTesteJid,
        name: config.grupoTesteNome || config.grupoTesteJid,
        label: "grupo de teste"
      };
    }

    return {
      jid: config.grupoAlvoJid,
      name: config.grupoAlvoNome || config.grupoAlvoJid,
      label: "grupo alvo"
    };
  }

  private refreshSocketJidFilterCache(config = this.configStore.load()) {
    const activeGroup = this.getActiveMonitoringGroup(config).jid;
    this.socketAllowedGroupJids = new Set(
      [activeGroup, config.grupoAlvoJid, config.grupoTesteJid]
        .map((item) => String(item || ""))
        .filter(Boolean)
    );
  }

  private shouldIgnoreSocketJid(jid: string) {
    const normalized = String(jid || "");
    if (!normalized) return false;
    if (normalized === "status@broadcast" || normalized.endsWith("@newsletter")) return true;
    if (!normalized.endsWith("@g.us")) return false;

    return this.socketAllowedGroupJids.size > 0 && !this.socketAllowedGroupJids.has(normalized);
  }

  private async sendWarmupMessage(jid: string, mensagem: string, messageNumber: number) {
    const maxAttempts = 3;
    const delays = [75, 150, 250];

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.relayTextMessage(this.sock, jid, mensagem);
        this.logger.success(`Aquecimento ${messageNumber} enviado.`);
        return true;
      } catch (error) {
        const message = this.getErrorMessage(error);
        if (attempt === maxAttempts) {
          this.logger.error(`Falha no aquecimento ${messageNumber}: ${message}`);
          return false;
        }

        this.logger.warning(`Aquecimento ${messageNumber} falhou (${message}). Retentando...`);
        await this.delay(delays[attempt] || 150);
      }
    }

    return false;
  }

  private async prewarmGroup(jid: string, label: string) {
    const config = this.configStore.load();
    this.logger.info(`Aquecer ${label}: ${jid}`);

    const metadata = await this.refreshGroupMetadata(jid);
    if (!metadata) {
      throw new Error(`Não foi possível obter metadata do ${label}.`);
    }

    if (label === "grupo alvo") {
      const currentUserIds = this.getCurrentUserIds();
      const participant = metadata.participants?.find((item: any) => {
        const id = String(item.id || "");
        const number = id.split(":")[0].split("@")[0];
        return currentUserIds.includes(id) || currentUserIds.includes(`${number}@s.whatsapp.net`);
      });

      if (!participant) {
        this.currentUserInTargetGroup = false;
        this.logger.warning("A conta conectada não está no grupo alvo. Verifique a participação antes de enviar.");
      } else {
        this.currentUserInTargetGroup = true;
      }

      this.groupState = metadata.announce === true ? "closed" : "open";
    }

    this.logger.success(`Aquecimento concluído para ${label}: ${metadata.subject || jid}`);
    return true;
  }

  async refreshGroups() {
    if (!this.sock || this.status !== "connected") {
      this.logger.warning("Conecte o WhatsApp antes de carregar a lista de grupos.");
      this.emitSnapshot();
      return;
    }

    await this.loadGroups();
    this.emitSnapshot();
  }

  clearLogs(silent = false) {
    this.logger.clear();
    if (!silent) this.logger.info("Logs limpos.");
    this.emitSnapshot();
  }

  clearRouteHistory(silent = false) {
    this.routeStore.clear();
    this.activeRouteByCycle.clear();
    if (!silent) this.logger.info("Histórico de disparos limpo.");
    this.emitSnapshot();
  }

  setGeneralSettings(settings: { nuclearMode: boolean; fastMode?: boolean; minSendDelayMs?: number; alwaysWarmMode?: boolean; keepAliveIntervalMs?: number; ocrManualRouteSelection?: boolean; ocrSelectionMode?: BotConfig["ocrSelectionMode"]; ocrDesiredCages?: string[]; ocrCageMessageLimit?: number }) {
    const currentConfig = this.configStore.load();
    const changingMode = Boolean(settings.nuclearMode) !== currentConfig.nuclearMode;
    if (this.monitoringEnabled && changingMode) {
      this.logger.warning("Pare o bot antes de trocar entre modo normal e modo nuclear.");
      this.emitSnapshot();
      return;
    }

    const nextSettings: Partial<BotConfig> = { nuclearMode: Boolean(settings.nuclearMode) };
    if (settings.fastMode !== undefined) nextSettings.fastMode = Boolean(settings.fastMode);
    if (settings.minSendDelayMs !== undefined) nextSettings.minSendDelayMs = settings.minSendDelayMs;
    if (settings.alwaysWarmMode !== undefined) nextSettings.alwaysWarmMode = Boolean(settings.alwaysWarmMode);
    if (settings.keepAliveIntervalMs !== undefined) nextSettings.keepAliveIntervalMs = settings.keepAliveIntervalMs;
    if (settings.ocrManualRouteSelection !== undefined) nextSettings.ocrManualRouteSelection = Boolean(settings.ocrManualRouteSelection);
    if (settings.ocrSelectionMode !== undefined) {
      nextSettings.ocrSelectionMode = settings.ocrSelectionMode;
      nextSettings.ocrManualRouteSelection = settings.ocrSelectionMode === "manual";
    }
    if (settings.ocrDesiredCages !== undefined) nextSettings.ocrDesiredCages = settings.ocrDesiredCages;
    if (settings.ocrCageMessageLimit !== undefined) nextSettings.ocrCageMessageLimit = settings.ocrCageMessageLimit;
    const config = this.configStore.save(nextSettings);
    this.refreshRuntimeSettings(config);
    this.prepareSendPlan();
    if (this.monitoringEnabled) void this.startWarmKeepAlive("armado");
    if (changingMode) {
      this.logger.success(config.nuclearMode ? "Modo nuclear ativado." : "Modo nuclear desativado.");
    }
    if (settings.ocrManualRouteSelection !== undefined) {
      this.logger.info(config.ocrManualRouteSelection
        ? "Bot imagem configurado para aprovação manual de rotas."
        : "Bot imagem configurado para enviar primeiro o bairro seguro com menos paradas.");
    }
    this.emitSnapshot();
  }

  setDispatchPriorityLevel(level: number) {
    const nextLevel = this.normalizeDispatchPriorityLevel(level);
    if (nextLevel === this.dispatchPriorityLevel) return;
    this.dispatchPriorityLevel = nextLevel;
    this.dispatchPriorityDelayMs = nextLevel > 0 ? Math.max(400, nextLevel * 400) : 0;
    this.emitSnapshot();
  }

  setDispatchPriorityDelayMs(delayMs: number) {
    const normalized = Number.isFinite(Number(delayMs)) ? Math.max(0, Math.min(MAX_DISPATCH_PRIORITY_DELAY_MS, Math.round(Number(delayMs)))) : 0;
    if (normalized === this.dispatchPriorityDelayMs) return;
    this.dispatchPriorityDelayMs = normalized;
    this.dispatchPriorityLevel = normalized > 0 ? 1 : 0;
    this.emitSnapshot();
  }

  setMessageCodes(codes: string[]) {
    // Set target (alvo) message codes. Do NOT reset warmup completion.
    this.codigosEscolhidos = codes.map((item) => item.trim().toUpperCase()).filter(Boolean);
    this.montarMensagens();
    this.configStore.save({ codigosMensagensAlvo: this.codigosEscolhidos });
    this.prepareSendPlan();
    this.logger.success("Mensagens do grupo alvo atualizadas.");
  }

  setMessageSettings(senderName: string, codes: string[], routes?: string[], monitoredRouteDetails?: MonitoredRoute[], targetDispatchMode?: BotConfig["targetDispatchMode"], ocrCageMessageLimit?: number, ocrMaxStops?: number, ocrMaxPackages?: number, ocrRouteChoiceMode?: BotConfig["ocrRouteChoiceMode"], ocrRouteChoiceMetric?: BotConfig["ocrRouteChoiceMetric"]) {
    if (typeof senderName !== "string" || !Array.isArray(codes) || codes.some((item) => typeof item !== "string")) throw new Error("Nome e códigos de mensagem inválidos.");
    // Update target (alvo) message settings. Do NOT reset warmup completion.
    this.codigosEscolhidos = codes.map((item) => item.trim().toUpperCase()).filter(Boolean);
    const monitoredRoutes = (routes || codes).map((item) => item.trim()).filter(Boolean);
    const detailedRoutes = (monitoredRouteDetails || [])
      .map((item) => ({
        cidade: "",
        bairro: String(item?.bairro || "").trim(),
        ...(typeof item?.regiao === "string" && item.regiao.trim() ? { regiao: item.regiao.trim() } : {}),
        enabled: item?.enabled !== false,
        ...(item?.conditionMetric === "stops" || item?.conditionMetric === "packages" ? {
          conditionMetric: item.conditionMetric,
          conditionMax: Math.max(0, Math.min(999, Math.floor(Number(item.conditionMax) || 0)))
        } : {})
      }))
      .filter((item) => item.bairro);
    this.configStore.save({
      nomeEnvio: senderName.trim(),
      codigosMensagensAlvo: this.codigosEscolhidos,
      rotasMonitoradas: monitoredRoutes,
      rotasMonitoradasDetalhadas: detailedRoutes,
      ...(ocrCageMessageLimit !== undefined ? { ocrCageMessageLimit } : {}),
      ...(ocrMaxStops !== undefined ? { ocrMaxStops } : {}),
      ...(ocrMaxPackages !== undefined ? { ocrMaxPackages } : {}),
      ...(ocrRouteChoiceMode ? { ocrRouteChoiceMode } : {}),
      ...(ocrRouteChoiceMetric ? { ocrRouteChoiceMetric } : {}),
      ...(targetDispatchMode ? { targetDispatchMode } : {})
    });
    this.cancelPendingRouteImageBatch();
    this.pendingOcrMessages = [];
    this.pendingOcrReconnectDispatch = undefined;
    this.acceptedMessageCountByCycle.clear();
    this.resetOcrRouteSelection();
    this.lastOcrDispatchKey = "";
    this.montarMensagens();
    this.prepareSendPlan();
    this.logger.success(targetDispatchMode === "ocr"
      ? `Bot imagem atualizado: ${detailedRoutes.length || monitoredRoutes.length} rota(s) monitorada(s).`
      : `Mensagens manuais atualizadas: ${this.codigosEscolhidos.length} código(s).`
    );
  }

  saveRoutePreset(name: string, routes: MonitoredRoute[]) {
    const presetName = name.trim();
    const normalizedRoutes = routes
      .map((route) => ({
        cidade: "", bairro: String(route?.bairro || "").trim(),
        ...(typeof route?.regiao === "string" && route.regiao.trim() ? { regiao: route.regiao.trim() } : {}),
        enabled: route?.enabled !== false,
        ...(route?.conditionMetric === "stops" || route?.conditionMetric === "packages" ? {
          conditionMetric: route.conditionMetric,
          conditionMax: Math.max(0, Math.min(999, Math.floor(Number(route.conditionMax) || 0)))
        } : {})
      }))
      .filter((route) => route.bairro);
    if (!presetName) throw new Error("Digite um nome para a configuração.");
    if (!normalizedRoutes.length) throw new Error("Adicione pelo menos um bairro antes de salvar a configuração.");
    const config = this.configStore.load();
    const now = new Date().toISOString();
    const existing = (config.routePresets || []).find((preset) => normalizarTexto(preset.name) === normalizarTexto(presetName));
    const preset = {
      id: existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: presetName,
      routes: normalizedRoutes,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    const routePresets = [preset, ...(config.routePresets || []).filter((item) => item.id !== preset.id)].slice(0, 50);
    this.configStore.save({ routePresets });
    this.logger.success(`Configuração de bairros salva: ${presetName} (${normalizedRoutes.length} rota(s)).`);
    this.emitSnapshot();
  }

  deleteRoutePreset(id: string) {
    const config = this.configStore.load();
    const routePresets = (config.routePresets || []).filter((preset) => preset.id !== id);
    if (routePresets.length === (config.routePresets || []).length) throw new Error("Configuração salva não encontrada.");
    this.configStore.save({ routePresets });
    this.logger.info("Configuração de bairros excluída.");
    this.emitSnapshot();
  }

  // Save warmup (teste) message settings. This resets the warmup state.
  setWarmupMessageSettings(senderName: string, codes: string[], messageCount?: number, intervalMs?: number) {
    if (typeof senderName !== "string" || !Array.isArray(codes) || codes.some((item) => typeof item !== "string")) throw new Error("Nome e códigos de mensagem inválidos.");
    this.resetWarmupState();
    const nextCodes = codes.map((item) => item.trim().toUpperCase()).filter(Boolean);
    const nextSettings: Partial<BotConfig> = {
      nomeEnvio: senderName.trim(),
      codigosMensagensTeste: nextCodes
    };
    if (messageCount !== undefined) nextSettings.testMessageCount = messageCount;
    if (intervalMs !== undefined) nextSettings.testMessageIntervalMs = intervalMs;
    const config = this.configStore.save(nextSettings);
    this.refreshRuntimeSettings(config);
    this.montarMensagens();
    this.logger.success(`Teste atualizado: ${config.testMessageCount} mensagens, intervalo ${config.testMessageIntervalMs}ms.`);
  }

  locateRomaneioInGroup(): RomaneioLocateResult {
    if (!this.sock || this.status !== "connected") {
      return {
        found: false,
        message: "Conecte o WhatsApp antes de localizar o romaneio.",
        candidates: []
      };
    }

    const activeGroup = this.getActiveMonitoringGroup();
    if (!activeGroup.jid) {
      return {
        found: false,
        message: "Configure o grupo alvo antes de localizar o romaneio.",
        candidates: []
      };
    }

    this.purgeOldRomaneioCandidates();
    const candidates = Array.from(this.romaneioDocumentCandidates.values())
      .map((item) => item.candidate)
      .filter((candidate) => candidate.groupJid === activeGroup.jid)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (!candidates.length) {
      const persisted = this.romaneioStore?.all();
      if (persisted?.status.loaded && persisted.routes.length) {
        const uploadedAt = persisted.status.uploadedAt
          ? new Date(persisted.status.uploadedAt).toLocaleString("pt-BR")
          : "data não informada";
        this.logger.success(`[ROMANEIO] Romaneio persistido restaurado: ${persisted.status.fileName || "latest.xlsx"}, ${persisted.status.totalRoutes} rota(s).`);
        return {
          found: true,
          message: `Romaneio já carregado do armazenamento persistente: ${persisted.status.fileName || "latest.xlsx"} (${persisted.status.totalRoutes} rotas, salvo em ${uploadedAt}).`,
          candidates: []
        };
      }
      this.logger.warning("[ROMANEIO] Nenhum arquivo de hoje com nome romaneio foi encontrado no histórico recebido do grupo alvo.");
      return {
        found: false,
        message: "Não encontrei arquivo .xlsx de hoje com 'romaneio' no nome. Aguarde alguns segundos após conectar ou peça para reenviar o arquivo no grupo.",
        candidates: []
      };
    }

    const morningCount = candidates.filter((candidate) => candidate.periodo === "manha").length;
    const afternoonCount = candidates.filter((candidate) => candidate.periodo === "tarde").length;
    this.logger.info(`[ROMANEIO] ${candidates.length} candidato(s) encontrado(s) no grupo alvo. Manhã: ${morningCount}. Tarde: ${afternoonCount}.`);
    return {
      found: true,
      message: `Romaneio encontrado. Confirme o arquivo correto: ${morningCount} manhã, ${afternoonCount} tarde.`,
      candidates
    };
  }

  async confirmRomaneioCandidate(candidateId: string): Promise<RomaneioSnapshot> {
    if (!this.romaneioStore) throw new Error("Armazenamento de romaneio não configurado.");
    if (!downloadMediaMessage) throw new Error("WhatsApp ainda não está pronto para baixar mídia.");

    const item = this.romaneioDocumentCandidates.get(candidateId);
    if (!item) throw new Error("Arquivo de romaneio não encontrado. Clique em localizar novamente.");

    const buffer = await downloadMediaMessage(
      item.message,
      "buffer",
      {},
      {
        logger: P({ level: "silent" }),
        reuploadRequest: this.sock?.updateMediaMessage
      }
    );
    const snapshot = this.romaneioStore.saveUpload(item.candidate.fileName, buffer);
    this.logger.success(`[ROMANEIO] Arquivo confirmado e processado (${item.candidate.periodoLabel}): ${item.candidate.fileName}. Rotas: ${snapshot.status.totalRoutes}. Pacotes: ${snapshot.status.totalPackages}.`);
    return snapshot;
  }

  private async connect() {
    const connectionId = ++this.activeConnectionId;
    this.qrReceivedInCurrentConnection = false;
    this.clearQrCode();
    this.estadoInicialDoGrupoCapturado = false;
    this.grupoJaFechouDepoisDoInicio = false;
    this.clearReconnectTimer();
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.error = "";
    this.logger.info(this.reconnectAttempts > 0 ? "Tentando reconectar..." : "Bot iniciado.");

    await loadBaileys();
    if (this.stopping || connectionId !== this.activeConnectionId) return;
    await this.closeAuthState?.().catch(() => undefined);
    if (this.stopping || connectionId !== this.activeConnectionId) return;
    this.closeAuthState = undefined;
    this.flushAuthState = undefined;
    this.destroyAuthState = undefined;

    let authSession: any;
    try {
      authSession = await useSqliteAuthState(this.authDir, {
        BufferJSON,
        proto,
        useMultiFileAuthState
      });
      if (this.stopping || connectionId !== this.activeConnectionId) {
        await authSession.close();
        return;
      }
      this.authBackend = "sqlite";
      this.flushAuthState = authSession.flush;
      this.closeAuthState = authSession.close;
      this.destroyAuthState = authSession.destroy;
      if (authSession.migratedFiles > 0) {
        this.logger.success(`Sessão migrada para SQLite: ${authSession.migratedFiles} chave(s) importada(s), backup antigo preservado.`);
      }
    } catch (error) {
      this.authBackend = "multi-file";
      this.logger.warning(`SQLite auth indisponível; usando sessão compatível em arquivos: ${this.getErrorMessage(error)}.`);
      authSession = await useMultiFileAuthState(this.authDir);
    }
    if (this.stopping || connectionId !== this.activeConnectionId) return;
    const { state, saveCreds } = authSession;
    this.saveCredsNow = saveCreds;
    const version = await this.getWhatsAppVersion();
    if (this.stopping || connectionId !== this.activeConnectionId) return;
    const socketLogger = P({ level: "silent" });
    const cachedKeys = makeCacheableSignalKeyStore
      ? makeCacheableSignalKeyStore(state.keys, socketLogger)
      : state.keys;
    const auth = {
      creds: state.creds,
      keys: this.profileSignalKeyStore(cachedKeys)
    };

    this.sock = makeWASocket({
      auth,
      version,
      logger: socketLogger,
      connectTimeoutMs: SOCKET_CONNECT_TIMEOUT_MS,
      defaultQueryTimeoutMs: SOCKET_QUERY_TIMEOUT_MS,
      keepAliveIntervalMs: SOCKET_KEEP_ALIVE_INTERVAL_MS,
      qrTimeout: QR_CODE_LIFETIME_MS,
      emitOwnEvents: true,
      fireInitQueries: true,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      // Histórico completo consome CPU e I/O sem ajudar o disparo em tempo real.
      syncFullHistory: false,
      browser: Browsers?.ubuntu?.("Bot Rota Rapida") || ["Ubuntu", "Chrome", "1.0.0"],
      shouldIgnoreJid: (jid: string) => this.shouldIgnoreSocketJid(jid),
      cachedGroupMetadata: async (jid: string) => this.groupMetadataCache.get(jid)
    });

    this.sock.ev.on("creds.update", () => this.scheduleCredsSave());
    this.sock.ev.on("connection.update", (update: any) => {
      void this.handleConnectionUpdate(update, connectionId).catch((error) => {
        if (connectionId !== this.activeConnectionId || this.stopping) return;
        this.logger.error(`Falha ao processar estado da conexão: ${this.getErrorMessage(error)}`);
      });
    });
    this.sock.ev.on("groups.update", (updates: any[]) =>
      this.handleGroupsUpdate(updates, connectionId, Date.now())
    );
    this.sock.ev.on("group-participants.update", (update: any) =>
      this.handleGroupParticipantsUpdate(update, connectionId)
    );
    this.sock.ev.on("messages.upsert", ({ messages }: any) => {
      const eventReceivedAt = Date.now();
      // Detecte abertura e inicie o relay antes de procurar documentos auxiliares.
      void this.handleMessages(messages, connectionId, eventReceivedAt).catch((error) => {
        this.logger.warning(`Evento de mensagem ignorado após erro: ${this.getErrorMessage(error)}`);
      });
      // Retornos de disparos anteriores são telemetria; uma abertura nova ganha
      // prioridade quando o WhatsApp agrupa ambos no mesmo lote.
      this.recordOutboundGroupEcho(messages || []);
      this.deferSecondarySocketTask(() => this.cacheRomaneioDocumentCandidates(messages || [], connectionId));
    });
    this.sock.ev.on("messages.update", (updates: any[]) => {
      this.deferSecondarySocketTask(() => {
        if (connectionId !== this.activeConnectionId) return;
        for (const item of updates || []) this.handleDeletedMessageUpdate(item);
      });
    });
    // Baileys messages.delete represents delete-for-me / local chat cleanup.
    // Only REVOKE protocol messages and stubs prove deletion in the group.
    this.sock.ev.on("messaging-history.set", ({ messages }: any) => {
      this.deferSecondarySocketTask(() => {
        if (connectionId !== this.activeConnectionId) return;
        this.cacheRomaneioDocumentCandidates(messages || [], connectionId);
        for (const message of messages || []) this.handleDeletedMessageNotice(message);
      });
    });

  }

  private async handleConnectionUpdate(update: any, connectionId: number) {
    if (connectionId !== this.activeConnectionId) return;

    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      const now = Date.now();
      this.unknownDisconnects = 0;
      this.qrReceivedInCurrentConnection = true;
      this.qrCode = qr;
      this.qrGeneratedAt = new Date(now).toISOString();
      this.qrExpiresAt = new Date(now + QR_CODE_LIFETIME_MS).toISOString();
      this.qrAttempt += 1;
      this.setStatus("waiting_qr");
      this.logger.info(`QR Code ${this.qrAttempt} gerado com validade ampliada.`);
    }

    if (isNewLogin) {
      this.clearQrCode(false);
      this.setStatus("reconnecting");
      this.logger.success("QR Code lido pelo WhatsApp. Finalizando a conexão...");
      await this.flushCreds().catch((error) => {
        this.logger.warning(`Não consegui salvar imediatamente a nova sessão: ${this.getErrorMessage(error)}`);
      });
    }

    if (connection === "open") {
      this.unknownDisconnects = 0;
      this.reconnectAttempts = 0;
      this.consecutiveHealthCheckFailures = 0;
      this.clearQrCode(false);
      this.setStatus("connected");
      this.addStatusEvent("connected", "WhatsApp conectado.");
      this.logger.success("WhatsApp conectado.");

      try {
        this.reportPendingDispatchesAfterBoot();
        await this.loadGroups();
        await this.resolveConfiguredGroup();
        const reconnectWarmup = this.startWarmKeepAlive("reconexão");
        if (this.monitoringEnabled) {
          await this.captureInitialGroupState();
          this.startHealthCheck();
          if (this.groupState !== "open") {
            await this.waitForInitialInternalWarmup(reconnectWarmup);
          }
          this.logger.success("Monitoramento restaurado após reconexão.");
          const recoveryHandled = await this.resumeOcrDispatchAfterReconnect();
          if (!recoveryHandled) this.dispatchIfGroupAlreadyOpen("reconexão");
        }
        this.logger.info("Aguardando abertura do grupo.");
      } catch (error) {
        this.error = this.getErrorMessage(error);
        this.setStatus("error");
        this.logger.error(this.error);
      }
    }

    if (connection === "close") {
      const closedSocket = this.sock;
      const interruptedCycleId = this.activeSendCycleId;
      if (
        this.monitoringEnabled &&
        this.monitoringMode === "target" &&
        this.preparedTargetDispatchMode === "ocr" &&
        this.pendingOcrMessages.length &&
        (!interruptedCycleId || (this.acceptedMessageCountByCycle.get(interruptedCycleId) || 0) === 0)
      ) {
        this.deferOcrDispatchUntilReconnect(
          this.activeSendTrigger === "manual" ? "manual" : "automatic",
          interruptedCycleId
        );
        if (interruptedCycleId && interruptedCycleId === this.sendCycleId) this.sendCycleId += 1;
      }
      this.sock = undefined;
      this.invalidateInternalWarmState();
      this.clearQrCode(false);
      this.clearHealthCheckTimer();
      this.clearWarmKeepAliveTimer();
      this.disposeSocket(closedSocket);
      await this.flushCreds().catch((error) => {
        this.logger.warning(`Falha ao persistir sessão ao fechar o socket: ${this.getErrorMessage(error)}`);
      });
      if (this.stopping) return;

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const errorMessage = this.getErrorMessage(lastDisconnect?.error);
      const disconnectDescription = this.getDisconnectDescription(statusCode, errorMessage);
      this.logger.warning(`Conexão fechada. Código: ${statusCode || "sem código"} | Erro: ${errorMessage}`);
      this.addStatusEvent("disconnected", `Conexão fechada: ${statusCode || "sem código"} ${errorMessage}`);

      if (this.isFatalRuntimeError(errorMessage)) {
        this.error = `Erro interno ao iniciar WhatsApp: ${errorMessage}`;
        this.setStatus("error");
        this.logger.error(this.error);
        return;
      }

      if (this.isRestartRequired(statusCode, errorMessage)) {
        this.reconnectAttempts = 0;
        this.unknownDisconnects = 0;
        this.logger.info("WhatsApp solicitou reinício da conexão. Credenciais preservadas; reconectando agora.");
        this.addStatusEvent("reconnecting", "WhatsApp solicitou reinício. Reconectando automaticamente.");
        this.scheduleReconnect(true);
        return;
      }

      if (this.isConnectionConflict(statusCode, errorMessage)) {
        this.logger.warning("Conflito de socket detectado. Sessão preservada; encerrando a conexão antiga antes de tentar novamente.");
        this.addStatusEvent("reconnecting", "Conflito de conexão resolvido sem apagar a sessão.");
        this.scheduleReconnect(false);
        return;
      }

      if (this.isQrRefAttemptLimit(statusCode, errorMessage)) {
        this.qrRefAttemptResets += 1;
        this.logger.warning(
          `QR Code expirou antes da leitura (${this.qrRefAttemptResets}x). Limpando tentativa parcial e gerando um QR novo.`
        );
        this.addStatusEvent("reconnecting", "QR Code expirou. Gerando um novo QR Code automaticamente.");
        this.resetPartialQrAuth();
        this.scheduleReconnect(true);
        return;
      }

      if (this.isInvalidSession(statusCode, errorMessage)) {
        if (this.autoClearInvalidSession && !this.clearedInvalidSessionInCurrentRun) {
          this.clearedInvalidSessionInCurrentRun = true;
          this.logger.warning(
            `Sessão inválida ou logout detectado (${statusCode || "sem código"}). Limpando auth_info e gerando QR novo.`
          );
          this.removeAuthDir();
          this.reconnectAttempts = 0;
          this.unknownDisconnects = 0;
          this.clearQrCode();
          this.scheduleReconnect(true);
          return;
        }

        this.failConnectionWithoutReconnect(
          `Sessão inválida ou logout detectado (${statusCode || "sem código"}). Parei para evitar loop de reconexão. Use Limpar sessão para gerar um novo QR Code.`
        );
        return;
      }

      if (!statusCode) {
        this.unknownDisconnects += 1;
        if (this.hasAuthSession() && !this.qrReceivedInCurrentConnection && this.unknownDisconnects % 3 === 0) {
          this.logger.warning(
            `A conexão fechou ${this.unknownDisconnects}x sem informar um motivo. ` +
            "A sessão foi preservada e o bot continuará tentando reconectar automaticamente."
          );
        }
      }

      this.logger.warning(`WhatsApp desconectado. ${disconnectDescription}.`);
      this.scheduleReconnect(false);
    }
  }

  private failConnectionWithoutReconnect(message: string) {
    this.clearReconnectTimer();
    this.clearHealthCheckTimer();
    this.clearWarmKeepAliveTimer();
    this.reconnectAttempts = Math.max(this.reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
    this.error = message;
    this.setStatus("error");
    this.logger.error(message);
  }

  private async resolveConfiguredGroup() {
    const config = this.configStore.load();
    const group = await this.resolveConfiguredTargetGroup(config);

    if (!group.jid) {
      this.logger.warning("Nenhum grupo configurado. Informe o nome ou ID na interface.");
      return;
    }

    const nextConfig: BotConfig = this.configStore.save({
      grupoAlvoJid: group.jid,
      grupoAlvoNome: group.name
    });

    await this.refreshGroupMetadata(nextConfig.grupoAlvoJid);
    this.prepareSendPlan();

    this.logger.success(`Grupo configurado: ${nextConfig.grupoAlvoNome}`);
  }

  private async resolveConfiguredTargetGroup(config: BotConfig) {
    if (config.grupoAlvoJid && this.groupMetadataCache.has(config.grupoAlvoJid)) {
      const metadata = this.groupMetadataCache.get(config.grupoAlvoJid);
      return {
        jid: config.grupoAlvoJid,
        name: String(metadata?.subject || config.grupoAlvoNome || "Grupo salvo")
      };
    }

    if (config.grupoAlvoNome) {
      const wanted = normalizarTexto(config.grupoAlvoNome);
      const foundByName = this.groups.find((group) => normalizarTexto(group.name) === wanted);

      if (foundByName) {
        this.logger.info("Grupo salvo por ID não foi encontrado. Revalidando pelo nome do grupo.");
        return {
          jid: foundByName.id,
          name: foundByName.name
        };
      }
    }

    if (config.grupoAlvoJid) {
      this.logger.warning(
        "O ID do grupo salvo não apareceu na lista atual do WhatsApp. Atualize a lista e salve o grupo novamente."
      );
      return {
        jid: "",
        name: config.grupoAlvoNome
      };
    }

    return resolveGroup(this.sock, {
      jid: config.grupoAlvoJid,
      name: config.grupoAlvoNome
    });
  }

  private async loadGroups() {
    const grupos = await this.sock.groupFetchAllParticipating();
    const listaGrupos = (Object.values(grupos) as any[])
      .map((grupo) => ({
        id: String(grupo.id || ""),
        name: String(grupo.subject || "Grupo sem nome")
      }))
      .filter((grupo) => grupo.id)
      .sort((a, b) => normalizarTexto(a.name).localeCompare(normalizarTexto(b.name)));

    this.groups = listaGrupos;

    for (const grupo of Object.values(grupos) as any[]) {
      if (grupo?.id) {
        this.groupMetadataCache.set(grupo.id, grupo);
      }
    }

    this.logger.success(`${this.groups.length} grupos carregados do WhatsApp.`);
  }

  private async captureInitialGroupState(): Promise<void> {
    try {
      const config = this.configStore.load();
      const activeGroup = this.getActiveMonitoringGroup(config);
      if (!activeGroup.jid || !this.sock) return;

      const metadata = await this.refreshGroupMetadata(activeGroup.jid);
      if (!metadata) return;
      this.lastFullMetadataWarmAt = Date.now();

      await Promise.all([
        this.prewarmActiveChat(activeGroup.jid),
        this.prewarmGroupCrypto(metadata)
      ]);

      const isGroupClosed = metadata.announce === true;
      this.groupState = isGroupClosed ? "closed" : "open";
      
      if (isGroupClosed) {
        this.estadoInicialDoGrupoCapturado = true;
        this.grupoJaFechouDepoisDoInicio = true;
        this.logger.info(`📌 Estado inicial do ${activeGroup.label}: FECHADO. Aguardando abertura...`);
      } else {
        this.estadoInicialDoGrupoCapturado = true;
        this.grupoJaFechouDepoisDoInicio = false;
        this.logger.info(`📌 Estado inicial do ${activeGroup.label}: ABERTO. Aguardando fechamento e reabertura...`);
      }
    } catch (error) {
      this.logger.warning(`Não foi possível capturar estado inicial do grupo: ${this.getErrorMessage(error)}`);
    }
  }

  private dispatchIfGroupAlreadyOpen(reason: "armado" | "reconexão") {
    if (!this.monitoringEnabled || this.monitoringMode !== "target" || this.groupState !== "open") return false;
    if (reason === "armado") {
      // Ao iniciar o automático com o grupo já aberto, aguarda um ciclo novo.
      // Isso evita entrar em uma abertura que começou antes de o bot ser armado.
      this.grupoJaFechouDepoisDoInicio = false;
      this.logger.info("Grupo já estava aberto ao armar o bot. Aguardando fechar e abrir novamente para enviar automaticamente.");
      return false;
    }
    if (this.preparedTargetDispatchMode === "ocr" && !this.pendingOcrMessages.length) {
      this.logger.info(`Grupo já está aberto após ${reason}. O bot imagem enviará assim que uma rota segura estiver pronta.`);
      return false;
    }

    if (this.activeSendCycle) return false;
    const cycleId = ++this.sendCycleId;
    const dispatched = this.enviarMensagensRapidas(cycleId, "automatic", Date.now(), "already_open");
    if (dispatched) {
      this.grupoJaFechouDepoisDoInicio = false;
      this.logger.success(`Grupo já estava aberto após ${reason}: disparo imediato acionado.`);
    }
    return dispatched;
  }

  private scheduleReconnect(forceNewQr: boolean) {
    this.clearReconnectTimer();
    if (this.stopping) return;

    if (MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.clearReconnectTimer();
      this.clearHealthCheckTimer();
      this.clearWarmKeepAliveTimer();
      this.error =
        "Limite de reconexão atingido. A internet pode estar instável ou a sessão pode estar inválida. Use Limpar sessão para gerar um novo QR Code.";
      this.setStatus("error");
      this.logger.error(this.error);
      return;
    }

    this.reconnectAttempts += 1;
    this.setStatus("reconnecting");
    this.addStatusEvent(
      "reconnecting",
      MAX_RECONNECT_ATTEMPTS > 0
        ? `Tentativa de reconexão ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}.`
        : `Tentativa de reconexão ${this.reconnectAttempts}.`
    );
    const backoffMs = forceNewQr
      ? 500
      : Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS + Math.max(0, this.reconnectAttempts - 1) * 2500);
    this.reconnectTimer = setTimeout(() => {
      if (this.stopping) return;
      this.connect().catch((error) => {
        if (this.stopping) return;
        this.error = this.getErrorMessage(error);
        this.logger.warning(`Reconexão falhou: ${this.error}`);
        this.scheduleReconnect(false);
      });
    }, backoffMs);
  }

  private handleGroupsUpdate(updates: any[], connectionId: number, eventReceivedAt = Date.now()) {
    if (connectionId !== this.activeConnectionId) return;
    if (!this.monitoringEnabled) return;

    const activeGroup = {
      jid: this.preparedTargetJid,
      label: this.monitoringMode === "test" ? "grupo de teste" : "grupo alvo"
    };
    if (!activeGroup.jid) return;

    for (const update of updates) {
      if (!update?.id || update.id !== activeGroup.jid) continue;

      if (update.announce === true) {
        this.groupState = "closed";
        this.grupoJaFechouDepoisDoInicio = true;
        this.sendCycleId += 1;
        this.activeSendCycle = undefined;
        this.criticalDispatchInProgress = false;
        this.logger.info(`🔒 ${activeGroup.label} FECHADO. Bot armado para próxima abertura.`);
        this.prepareSendPlan();
        this.scheduleClosingWarmup();
        this.logger.info("Plano de disparo preparado em memória para a próxima abertura.");
        return;
      }

      if (update.announce === false) {
        this.lastOpeningSignalAt = eventReceivedAt;
        this.groupState = "open";
        if (!this.grupoJaFechouDepoisDoInicio) {
          this.logger.info(`⚠️ ${activeGroup.label} já estava aberto desde o início. Aguardando próximo ciclo de fechamento e reabertura...`);
          return;
        }

        if (this.monitoringMode === "target" && this.preparedTargetDispatchMode === "ocr" && !this.pendingOcrMessages.length) {
          this.grupoJaFechouDepoisDoInicio = false;
          this.logger.info("Grupo abriu, mas o bot imagem ainda não tem rota segura lida da foto. Nenhuma mensagem enviada.");
          return;
        }

        const cycleId = ++this.sendCycleId;
        this.grupoJaFechouDepoisDoInicio = false;
        this.enviarMensagensRapidas(cycleId, this.monitoringMode === "test" ? "warmup" : "automatic", eventReceivedAt, "group_update");
        this.logger.info(`⚡ ${activeGroup.label} ABRIU! Disparo acionado.`);
        return;
      }
    }
  }

  private handleGroupParticipantsUpdate(update: any, connectionId: number) {
    if (connectionId !== this.activeConnectionId) return;
    const groupJid = String(update?.id || "");
    if (!groupJid || groupJid !== this.preparedTargetJid) return;

    this.groupMetadataCache.delete(groupJid);
    this.warmedGroupParticipantSignature = "";
    this.lastGroupCryptoWarmAt = 0;
    this.warmedGroupDeviceCount = 0;
    this.lastSenderKeyWarmAt = 0;
    this.invalidateInternalWarmState();

    if (this.criticalDispatchInProgress || !this.sock) return;

    this.deferSecondarySocketTask(() => {
      void this.runWarmKeepAlive("timer");
    });
  }

  private async handleMessages(messages: any[], connectionId: number, eventReceivedAt = Date.now()) {
    if (connectionId !== this.activeConnectionId) return;
    // Revocations remain relevant after sending has stopped, including in a
    // previous target group. Keep their audit work outside the relay path.
    this.deferSecondarySocketTask(() => {
      if (connectionId !== this.activeConnectionId) return;
      for (const msg of messages || []) this.handleDeletedMessageNotice(msg);
    });
    if (!this.monitoringEnabled) {
      this.scheduleReactionProcessing(messages);
      return;
    }

    const activeGroup = {
      jid: this.preparedTargetJid,
      label: this.monitoringMode === "test" ? "grupo de teste" : "grupo alvo"
    };
    if (!activeGroup.jid) {
      this.scheduleReactionProcessing(messages);
      return;
    }
    for (const msg of messages || []) {
      if (!msg?.message || !msg.key?.remoteJid) continue;
      if (msg.key.remoteJid !== activeGroup.jid) continue;

      if (this.monitoringMode === "target" && this.preparedTargetDispatchMode === "ocr" && msg.message.imageMessage) {
        this.logger.info("Imagem recebida no grupo alvo. Conferindo bairros preferidos e gaiolas na mesma linha.");
        this.scheduleRouteImageProcessing(msg, activeGroup.jid);
      }

      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      if (!texto) {
        continue;
      }

      const textoNormalizado = normalizarTexto(texto);

      const detectouAbertura = OPENING_TRIGGER_WORDS.some((palavra) => textoNormalizado.includes(palavra));

      if (detectouAbertura) {
        this.lastOpeningSignalAt = eventReceivedAt;
        this.groupState = "open";
        if (!this.grupoJaFechouDepoisDoInicio) {
          this.logger.info(
            "Palavra de abertura detectada, mas o grupo ainda não fechou após o bot iniciar. Nenhuma mensagem enviada."
          );
          this.scheduleReactionProcessing(messages);
          return;
        }

        if (this.monitoringMode === "target" && this.preparedTargetDispatchMode === "ocr" && !this.pendingOcrMessages.length) {
          this.grupoJaFechouDepoisDoInicio = false;
          this.logger.info("Palavra de abertura detectada, mas o bot imagem ainda não tem rota segura lida da foto. Nenhuma mensagem enviada.");
          this.scheduleReactionProcessing(messages);
          return;
        }

        const cycleId = ++this.sendCycleId;
        this.grupoJaFechouDepoisDoInicio = false;
        this.enviarMensagensRapidas(cycleId, this.monitoringMode === "test" ? "warmup" : "automatic", eventReceivedAt, "opening_message");
        this.logger.info("Palavra de abertura detectada. Rajada instantânea acionada.");
        this.scheduleReactionProcessing(messages);
        return;
      }

    }

    this.scheduleReactionProcessing(messages);
  }

  private scheduleReactionProcessing(messages: any[]) {
    const reactions = (messages || []).filter((msg) => msg?.message?.reactionMessage);
    if (!reactions.length) return;

    this.pendingReactionBatch = [...(this.pendingReactionBatch || []), ...reactions].slice(-100);
    if (this.reactionProcessingScheduled) return;

    this.reactionProcessingScheduled = true;
    setTimeout(() => {
      const batch = this.pendingReactionBatch || [];
      this.pendingReactionBatch = undefined;
      this.reactionProcessingScheduled = false;

      if (this.criticalDispatchInProgress) {
        this.scheduleReactionProcessing(batch);
        return;
      }

      void this.handleReactions(batch).catch((error) => {
        this.logger.warning(`Reações processadas fora do caminho crítico falharam: ${this.getErrorMessage(error)}`);
      });
    }, this.criticalDispatchInProgress ? 3000 : this.monitoringEnabled ? 5000 : 0);
  }

  private scheduleRouteImageProcessing(msg: any, groupJid: string) {
    if (this.preparedTargetDispatchMode !== "ocr" || !downloadMediaMessage) return;

    const messageId = String(msg?.key?.id || "");
    if (!messageId || this.processingImageIds.has(messageId)) return;

    this.processingImageIds.add(messageId);
    this.pendingRouteImageBatch.push({ msg, groupJid, messageId });
    // Give immediate visual feedback while the short batching window and
    // media download are still pending. The definitive analysis state reuses
    // this id for the usual single-image flow.
    this.ocrRouteSelection = {
      status: "analyzing",
      options: [],
      analysisId: `${this.clientEmail}:${messageId}`,
      processedAt: new Date().toISOString(),
      estimatedDurationSeconds: this.estimateOcrAnalysisSeconds(),
      message: "Imagem recebida. Preparando a leitura agora..."
    };
    this.emitSnapshot();
    if (this.routeImageBatchTimer) clearTimeout(this.routeImageBatchTimer);
    const flush = () => {
      this.routeImageBatchTimer = undefined;
      if (this.routeImageBatchProcessing || this.activeSendCycle) {
        this.routeImageBatchTimer = setTimeout(flush, ROUTE_IMAGE_BATCH_QUIET_MS);
        return;
      }
      const batch = this.pendingRouteImageBatch.splice(0, ROUTE_IMAGE_BATCH_MAX);
      if (!batch.length) return;
      const sequence = ++this.latestRouteImageSequence;
      this.routeImageBatchProcessing = true;
      this.logger.info(batch.length > 1
        ? `[ROMANEIO] ${batch.length} imagens recebidas juntas. Analisando como um único lote.`
        : "[ROMANEIO] Imagem encaminhada para análise.");
      void this.processRouteImageBatch(batch, sequence).finally(() => {
        this.routeImageBatchProcessing = false;
        for (const item of batch) this.processingImageIds.delete(item.messageId);
        if (this.pendingRouteImageBatch.length) this.schedulePendingRouteImageBatch();
      }).catch((error) => this.logger.warning(`Falha ao concluir análise da imagem: ${this.getErrorMessage(error)}`));
    };
    if (this.pendingRouteImageBatch.length >= ROUTE_IMAGE_BATCH_MAX) flush();
    else this.routeImageBatchTimer = setTimeout(flush, this.criticalDispatchInProgress ? 3000 : ROUTE_IMAGE_BATCH_QUIET_MS);
  }

  private cancelPendingRouteImageBatch() {
    if (this.routeImageBatchTimer) clearTimeout(this.routeImageBatchTimer);
    this.routeImageBatchTimer = undefined;
    for (const item of this.pendingRouteImageBatch) this.processingImageIds.delete(item.messageId);
    this.pendingRouteImageBatch = [];
    this.latestRouteImageSequence += 1;
  }

  private schedulePendingRouteImageBatch() {
    if (this.routeImageBatchTimer || this.routeImageBatchProcessing || !this.pendingRouteImageBatch.length) return;
    this.routeImageBatchTimer = setTimeout(() => {
      this.routeImageBatchTimer = undefined;
      if (this.activeSendCycle) { this.schedulePendingRouteImageBatch(); return; }
      const batch = this.pendingRouteImageBatch.splice(0, ROUTE_IMAGE_BATCH_MAX);
      const sequence = ++this.latestRouteImageSequence;
      this.routeImageBatchProcessing = true;
      void this.processRouteImageBatch(batch, sequence).finally(() => {
        this.routeImageBatchProcessing = false;
        for (const item of batch) this.processingImageIds.delete(item.messageId);
        this.schedulePendingRouteImageBatch();
      }).catch((error) => this.logger.warning(`Falha ao concluir análise da imagem: ${this.getErrorMessage(error)}`));
    }, this.criticalDispatchInProgress ? 3000 : ROUTE_IMAGE_BATCH_QUIET_MS);
  }

  private async downloadRouteImage(message: unknown, socket: any): Promise<Buffer> {
    return downloadMediaMessage(message, "buffer", { options: { signal: AbortSignal.timeout(30_000) } }, {
      logger: P({ level: "silent" }),
      reuploadRequest: socket.updateMediaMessage
    });
  }

  private async processRouteImageBatch(batch: Array<{ msg: any; groupJid: string; messageId: string }>, sequence: number) {
    if (!batch.length || sequence !== this.latestRouteImageSequence) return;
    const groupJid = batch[0].groupJid;
    const config = this.configStore.load();
    const analysisSocket = this.sock;
    // All clients receiving the same set of images coordinate the same event,
    // even when WhatsApp delivered that set in a different order.
    const messageId = [...new Set(batch.map((item) => item.messageId))].sort().join("+");
    const analysisId = `${this.clientEmail}:${messageId}`;
    const analysisStartedAtMs = Date.now();
    const analysisStartedAt = new Date(analysisStartedAtMs).toISOString();
    let imageDirectory: string | undefined;
    let imagePreviewUrl: string | undefined;
    let previewPromise: Promise<void> = Promise.resolve();
    let dispatchRaceReady = false;
    let analysisWatchdog: NodeJS.Timeout | undefined;
    const isCurrent = () => sequence === this.latestRouteImageSequence && this.monitoringEnabled && this.configStore.load().targetDispatchMode === "ocr";
    const reportState = (state: DispatchRaceEventState) => this.dispatchRaceEventReporter?.({
      clientEmail: this.clientEmail, groupKey: groupJid, eventDetectedAt: analysisStartedAtMs, eventKey: messageId, state
    });
    const groupName = this.groups.find((group) => group.id === groupJid)?.name || config.grupoAlvoNome || groupJid;
    const analysisContext = () => {
      const finishedAt = Date.now();
      return {
        groupJid, groupName, analysisStartedAt,
        analysisFinishedAt: new Date(finishedAt).toISOString(),
        analysisDurationMs: Math.max(0, finishedAt - analysisStartedAtMs)
      };
    };
    const failCurrentAnalysis = (message: string) => {
      if (this.ocrRouteSelection.analysisId !== analysisId || this.ocrRouteSelection.status !== "analyzing") return;
      this.latestRouteImageSequence += 1;
      this.pendingOcrMessages = [];
      this.preparedMessages = [];
      this.preparedRelayMessages = [];
      this.pendingOcrReconnectDispatch = undefined;
      this.ocrRouteSelection = { ...this.ocrRouteSelection, status: "error", processedAt: new Date().toISOString(), message };
      this.rememberCurrentOcrAnalysis();
      this.emitSnapshot();
    };
    const readOcrWithTimeout = (imagePath: string, options: { maxReadings: number; fastFirst: boolean; preferCageCrop: boolean }) => {
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("A leitura da imagem ultrapassou o limite de tempo.")), 125_000);
        timeout.unref?.();
      });
      return Promise.race([readRouteImageOcrWithoutBlockingSocket(imagePath, options), deadline])
        .finally(() => { if (timeout) clearTimeout(timeout); });
    };

    try {
      reportState("processing");
      this.ocrRouteSelection = {
        status: "analyzing", options: [], analysisId, processedAt: new Date().toISOString(),
        estimatedDurationSeconds: this.estimateOcrAnalysisSeconds(),
        message: "Conferindo bairros e gaiolas da imagem..."
      };
      this.pendingOcrMessages = [];
      this.preparedMessages = [];
      this.preparedRelayMessages = [];
      this.pendingOcrReconnectDispatch = undefined;
      this.emitSnapshot();
      analysisWatchdog = setTimeout(() => {
        failCurrentAnalysis("A leitura demorou mais de 3 minutos e foi interrompida por segurança. Nenhuma rota desta imagem será enviada; feche o aviso e tente novamente.");
        reportState("unavailable");
      }, 3 * 60_000);
      analysisWatchdog.unref?.();
      if (config.targetDispatchMode !== "ocr" || !analysisSocket || !this.monitoringEnabled) {
        throw new Error("O monitoramento foi parado ou a conexão mudou antes de a leitura começar.");
      }
      const preferences = this.getConfiguredOcrPreferences(config);
      if (!config.nomeEnvio.trim()) throw new Error("Configure o nome de envio antes de analisar.");

      // IDs of WhatsApp images are shared across clients. Never use those IDs
      // as a globally shared temp path: one client could delete another's input.
      imageDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bot-route-analysis-"));
      const imagePaths = batch.map((_item, index) => path.join(imageDirectory!, `${index}.jpg`));
      for (let index = 0; index < batch.length; index += 1) {
        const buffer = await this.downloadRouteImage(batch[index].msg, analysisSocket);
        if (!isCurrent()) { failCurrentAnalysis("A leitura foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada."); return; }
        await fs.promises.writeFile(imagePaths[index], buffer);
      }
      // The OCR keeps using the original complete image. This compact copy is
      // only for visual confirmation in the panel and never feeds detection.
      const downloadFinishedAtMs = Date.now();
      // A prévia é apenas visual e não precisa bloquear o início da IA. No
      // perfil dedicado, Sharp trabalha em paralelo enquanto o OCR lê a foto.
      previewPromise = (async () => {
        try {
          const { default: sharp } = await import("sharp");
          const preview = await sharp(imagePaths[0]).rotate().resize({ width: 960, withoutEnlargement: true })
            .jpeg({ quality: 60, mozjpeg: true }).toBuffer();
          imagePreviewUrl = `data:image/jpeg;base64,${preview.toString("base64")}`;
          this.ocrRouteSelection = { ...this.ocrRouteSelection, imagePreviewUrl };
          this.emitSnapshot();
        } catch (error) {
          this.logger.warning(`Não consegui gerar a prévia da imagem: ${this.getErrorMessage(error)}`);
        }
      })();
      let readings = [];
      for (const imagePath of imagePaths) {
        if (!isCurrent()) { failCurrentAnalysis("A leitura foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada."); return; }
        // Start with one higher-resolution structural reading. Most screenshots
        // are tabular and do not benefit from making several OCR workers compete
        // for CPU before we know that a second interpretation is necessary.
        readings.push(await readOcrWithTimeout(imagePath, {
          maxReadings: 1, fastFirst: true, preferCageCrop: false
        }));
      }
      if (!isCurrent()) { failCurrentAnalysis("A leitura foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada."); return; }
      let ocr = combineRouteImageBatch(readings);
      let decision = selectPreferredNeighborhoodFromOcr(ocr, preferences, config.ocrMaxStops, config.ocrMaxPackages, config.ocrRouteChoiceMode, config.ocrRouteChoiceMetric);
      const selectedMetrics = decision.selections.map(({ detection }) => detection);
      const mixedStops = selectedMetrics.some(({ paradas }) => paradas !== undefined)
        && selectedMetrics.some(({ paradas }) => paradas === undefined);
      const mixedPackages = selectedMetrics.some(({ pacotes }) => pacotes !== undefined)
        && selectedMetrics.some(({ pacotes }) => pacotes === undefined);
      const centroNeedsRegionConfirmation = preferences.some((preference) => isCentroNeighborhood(preference.bairro) && preference.regiao)
        && !decision.detections.some((candidate) => isCentroNeighborhood(candidate.bairro || "") && candidate.safeForAutomatic)
        && findManualRouteCandidatesFromOcr(ocr).some((candidate) => isCentroNeighborhood(candidate.bairro || ""));
      const needsReinforcedReading = decision.status !== "selected" || !decision.detection || mixedStops || mixedPackages || centroNeedsRegionConfirmation;
      if (needsReinforcedReading) {
        readings = [];
        for (const imagePath of imagePaths) {
          if (!isCurrent()) { failCurrentAnalysis("A leitura foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada."); return; }
          readings.push(await readOcrWithTimeout(imagePath, {
            maxReadings: 5, fastFirst: true, preferCageCrop: false
          }));
        }
        if (!isCurrent()) { failCurrentAnalysis("A leitura foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada."); return; }
        ocr = combineRouteImageBatch(readings);
        decision = selectPreferredNeighborhoodFromOcr(ocr, preferences, config.ocrMaxStops, config.ocrMaxPackages, config.ocrRouteChoiceMode, config.ocrRouteChoiceMetric);
      }
      await previewPromise;
      const ocrFinishedAtMs = Date.now();
      const comparedAt = Date.now();
      const timing = {
        startedAt: analysisStartedAt,
        downloadMs: downloadFinishedAtMs - analysisStartedAtMs,
        ocrMs: ocrFinishedAtMs - downloadFinishedAtMs,
        comparisonMs: comparedAt - ocrFinishedAtMs
      };
      const detected = decision.detection;
      if (decision.status !== "selected" || !detected) {
        const manualOptions: OcrRouteOption[] = findManualRouteCandidatesFromOcr(ocr).slice(0, 12).map((candidate, index) => ({
          id: `manual-image::${analysisId}::${candidate.code}`,
          rank: index + 1,
          rota: candidate.route || candidate.line,
          gaiola: candidate.code,
          bairro: candidate.bairro || "Destino não confirmado",
          cidade: candidate.cidade,
          regiao: candidate.regiao,
          distanciaKm: 0, pacotes: candidate.pacotes || 0, paradas: candidate.paradas || 0,
          passedFilters: false,
          reasons: ["Rota detectada na imagem; exige confirmação manual antes do envio."],
          score: candidate.confidence,
          manualOnly: true,
          observation: candidate.line
        }));
        this.emit("image-analysis", { id: analysisId, messageId, result: "unreadable", ...analysisContext() });
        this.lastOcrInsight = undefined;
        this.ocrRouteSelection = {
          status: manualOptions.length ? "ready" : "error", analysisId, options: manualOptions, source: ocr.source,
          imagePreviewUrl,
          line: ocr.text.slice(0, 1200),
          timing: { ...timing, totalMs: comparedAt - analysisStartedAtMs },
          detectedRouteCount: manualOptions.length,
          processedAt: new Date().toISOString(),
          message: manualOptions.length
            ? `${decision.reason} Detectei ${manualOptions.length} rota(s); selecione manualmente para enviar.`
            : decision.reason
        };
        this.logger.warning(`[IA] Envio bloqueado: ${decision.reason}`);
        this.rememberCurrentOcrAnalysis();
        this.emitSnapshot();
        return;
      }

      const messageLimit = Math.max(1, Math.min(3, Number(config.ocrCageMessageLimit) || 3));
      const selections = (decision.selections.length ? decision.selections : [{
        preferenceIndex: decision.preferenceIndex!, detection: detected
      }]).slice(0, messageLimit);
      const options: OcrRouteOption[] = selections.map(({ preferenceIndex, detection }, rank) => {
        const preference = preferences[preferenceIndex];
        return {
          id: `neighborhood::${analysisId}::${preferenceIndex}::${detection.code}`,
          rank: rank + 1, rota: detection.route, gaiola: detection.code,
          bairro: preference.bairro, cidade: detection.cidade,
          regiao: detection.regiao,
          distanciaKm: 0, pacotes: detection.pacotes || 0, paradas: detection.paradas || 0,
          passedFilters: true,
          reasons: [`Preferência ${preferenceIndex + 1}: ${preference.bairro}`, "Bairro e gaiola conferidos na mesma linha em leituras concordantes.", detection.paradas ? `${detection.paradas} paradas identificadas após o AT.` : "", detection.pacotes ? `${detection.pacotes} pacotes identificados.` : ""].filter(Boolean),
          score: detection.confidence,
          observation: `${detection.regiao ? `Região: ${detection.regiao}. ` : ""}Selecionado diretamente da imagem, sem romaneio.`
        };
      });
      const option = options[0];
      this.lastOcrDispatchKey = `${groupJid}:${messageId}:${options.map((item) => item.gaiola).join(",")}`;
      this.lastOcrInsight = {
        analysisId, source: ocr.source, text: ocr.text, line: detected.line,
        route: detected.route, cidade: option.cidade, bairro: option.bairro, regiao: option.regiao,
        code: detected.code, paradas: option.paradas, pacotes: option.pacotes, confidence: detected.confidence, processedAt: new Date().toISOString(),
        imagePreviewUrl, analysisOptions: options, analysisTiming: { ...timing, totalMs: comparedAt - analysisStartedAtMs },
        analysisMessage: decision.reason,
        preparedMessages: options.map((item) => `${config.nomeEnvio} ${item.gaiola}`.trim())
      };
      this.emit("image-analysis", {
        id: analysisId, messageId, result: "detected", route: detected.route,
        bairro: option.bairro, gaiola: detected.code, confidence: detected.confidence, ...analysisContext()
      });
      this.ocrRouteSelection = {
        status: "ready", analysisId, timing, source: ocr.source, line: detected.line,
        imagePreviewUrl,
        detected: { rota: detected.route, bairro: option.bairro, gaiola: detected.code },
        processedAt: new Date().toISOString(), options, detectedRouteCount: options.length,
        message: `${options.length} bairro(s) confirmado(s): ${options.map((item) => `${item.bairro}, gaiola ${item.gaiola}${item.paradas ? `, ${item.paradas} paradas` : ""}${item.pacotes ? `, ${item.pacotes} pacotes` : ""}`).join("; ")}. ${decision.reason}`
      };
      this.applyOcrRouteSelection(options, "automatic");
      dispatchRaceReady = true;
      reportState("ready");
      // Publish confirmation before group validation and dispatch. Later
      // snapshots report sending and WhatsApp acknowledgement independently.
      this.emitSnapshot();
      this.logger.success(`[IA] ${options.map((item) => `${item.bairro} corresponde à gaiola ${item.gaiola}`).join("; ")}. Rotas ordenadas pela menor quantidade de paradas.`);
      const sentImmediately = await this.dispatchPreparedOcrIfGroupOpen("automatic");
      if (!sentImmediately && isCurrent()) this.logger.info("[IA] Bairro e gaiola preparados; aguardando abertura do grupo ou recuperação da conexão.");
      this.emitSnapshot();
    } catch (error) {
      dispatchRaceReady = false;
      if (!isCurrent()) {
        failCurrentAnalysis("A análise foi interrompida porque o bot ou as preferências mudaram. Nenhuma rota foi enviada.");
        return;
      }
      this.emit("image-analysis", { id: analysisId, messageId, result: "failed", ...analysisContext() });
      this.ocrRouteSelection = {
        status: "error", analysisId, options: [], processedAt: new Date().toISOString(),
        imagePreviewUrl,
        message: `Análise da IA falhou: ${this.getErrorMessage(error)}`
      };
      this.rememberCurrentOcrAnalysis();
      this.emitSnapshot();
      this.logger.warning(`Análise da IA falhou: ${this.getErrorMessage(error)}`);
    } finally {
      if (analysisWatchdog) clearTimeout(analysisWatchdog);
      await previewPromise;
      if (!dispatchRaceReady || !isCurrent()) reportState("unavailable");
      if (sequence === this.latestRouteImageSequence) {
        this.ocrAnalysisDurationsMs = [...this.ocrAnalysisDurationsMs, Date.now() - analysisStartedAtMs].slice(-10);
      }
      if (imageDirectory) {
        // Only remove this invocation's mkdtemp directory inside the OS temp root.
        const resolved = path.resolve(imageDirectory);
        if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("bot-route-analysis-")) {
          await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => {
            this.logger.warning("Não consegui remover uma imagem temporária da análise.");
          });
        }
      }
    }
  }

  async confirmOcrRouteSelection(optionIds: string[]) {
    const selection = this.ocrRouteSelection;
    if (selection.status !== "ready" || !selection.options.length) {
      throw new Error("Nenhuma análise de imagem aguardando confirmação.");
    }

    const manualLimit = Math.max(1, Math.min(3, Number(this.configStore.load().ocrCageMessageLimit) || 3));
    const selected = optionIds
      .filter(Boolean)
      .slice(0, manualLimit)
      .map((id) => selection.options.find((option) => option.id === id))
      .filter(Boolean) as OcrRouteOption[];
    if (!selected.length) throw new Error("Selecione pelo menos uma rota.");
    if (selected.some((option) => !option.manualOnly && (!option.passedFilters || option.romaneioMatch === false))) {
      throw new Error("A rota selecionada não respeita todos os filtros ou não foi confirmada no romaneio.");
    }

    const first = selected[0];
    this.lastOcrInsight = {
      analysisId: selection.analysisId,
      source: selection.source || "revisão manual",
      text: selection.line,
      line: first.observation || selection.line,
      route: first.rota,
      cidade: first.cidade,
      bairro: first.bairro,
      regiao: first.regiao,
      code: first.gaiola,
      paradas: first.paradas,
      pacotes: first.pacotes,
      confidence: first.score,
      processedAt: new Date().toISOString(),
      imagePreviewUrl: selection.imagePreviewUrl,
      analysisOptions: selected,
      analysisTiming: selection.timing,
      analysisMessage: selection.message,
      preparedMessages: selected.map((option) => `${this.configStore.load().nomeEnvio} ${option.gaiola}`.trim())
    };
    this.applyOcrRouteSelection(selected, "manual");
    await this.dispatchPreparedOcrIfGroupOpen("manual");
    this.emitSnapshot();
  }

  private async dispatchPreparedOcrIfGroupOpen(trigger: "manual" | "automatic") {
    const activeGroup = this.getActiveMonitoringGroup();
    if (!activeGroup.jid || !this.pendingOcrMessages.length) return false;

    if (trigger === "automatic") {
      const violation = this.findOcrConditionViolation(this.lastOcrInsight?.analysisOptions || []);
      if (violation) {
        this.pendingOcrMessages = [];
        this.preparedMessages = [];
        this.preparedRelayMessages = [];
        this.pendingOcrReconnectDispatch = undefined;
        this.ocrRouteSelection = {
          ...this.ocrRouteSelection,
          status: "error",
          dispatchState: "failed",
          message: `${violation} Envio automático bloqueado pela condição do bairro.`
        };
        this.rememberCurrentOcrAnalysis();
        this.logger.warning(`[IA] ${violation} Envio automático bloqueado.`);
        this.emitSnapshot();
        return false;
      }
    }

    const analysisId = this.lastOcrInsight?.analysisId;
    const previousDispatch = trigger === "automatic" && analysisId
      ? this.routeStore.all().find((route) => route.ocr?.analysisId === analysisId && route.confirmedCount > 0)
      : undefined;
    if (previousDispatch) {
      this.pendingOcrReconnectDispatch = undefined;
      this.logger.info("[ROMANEIO] Esta imagem já teve mensagem aceita pelo WhatsApp. Recuperação duplicada cancelada.");
      return false;
    }

    if (this.status !== "connected" || !this.sock) {
      this.deferOcrDispatchUntilReconnect(trigger);
      return false;
    }

    let isOpen = this.groupState === "open";
    if (!isOpen) {
      try {
        const metadata = await this.refreshGroupMetadata(activeGroup.jid);
        if (metadata?.announce === false) {
          this.groupState = "open";
          isOpen = true;
        } else if (metadata?.announce === true) {
          this.groupState = "closed";
          isOpen = false;
        }
      } catch (error) {
        this.logger.warning(`[ROMANEIO] Não consegui atualizar o estado do grupo após a imagem: ${this.getErrorMessage(error)}. Usando estado em memória.`);
      }
    }

    if (!isOpen) {
      if (this.pendingOcrReconnectDispatch) {
        this.pendingOcrReconnectDispatch = undefined;
        this.logger.info("[ROMANEIO] WhatsApp reconectou com o grupo fechado. A rota continua pronta para a próxima abertura.");
      }
      return false;
    }
    if (this.status !== "connected" || !this.sock) {
      this.deferOcrDispatchUntilReconnect(trigger);
      return false;
    }
    if (!this.monitoringEnabled || this.preparedTargetDispatchMode !== "ocr") return false;
    const cycleId = this.activeSendCycle ? this.sendCycleId : ++this.sendCycleId;
    const recoveryBeforeDispatch = this.pendingOcrReconnectDispatch;
    this.pendingOcrReconnectDispatch = undefined;
    const dispatched = this.enviarMensagensRapidas(cycleId, trigger, Date.now(), "image_ready");
    if (!dispatched) {
      if (!this.pendingOcrReconnectDispatch && recoveryBeforeDispatch) {
        this.pendingOcrReconnectDispatch = recoveryBeforeDispatch;
      }
      this.logger.warning("[ROMANEIO] A rota ficou pronta com o grupo aberto, mas outro disparo ainda estava concluindo. Tentarei novamente imediatamente após ele terminar.");
      const activeCycle = this.activeSendCycle;
      if (activeCycle) {
        void activeCycle.then(() => {
          if (this.groupState === "open" && this.monitoringEnabled) return this.dispatchPreparedOcrIfGroupOpen(trigger);
        }).catch((error) => this.logger.warning(`Não consegui retomar a rota preparada: ${this.getErrorMessage(error)}`));
      }
      return false;
    }
    this.grupoJaFechouDepoisDoInicio = false;
    const dispatchedAnalysisId = this.lastOcrInsight?.analysisId;
    const dispatchedMessages = [...this.pendingOcrMessages];
    const dispatchCycle = this.activeSendCycle;
    this.ocrRouteSelection = {
      ...this.ocrRouteSelection,
      dispatchState: "sending",
      dispatchGroupName: activeGroup.name || this.configStore.load().grupoAlvoNome || "grupo alvo",
      message: `Enviando agora: ${dispatchedMessages.join(" | ")}.`
    };
    this.logger.info(trigger === "automatic"
      ? "[ROMANEIO] Grupo já estava aberto: disparo da melhor rota iniciado imediatamente após a imagem."
      : "[ROMANEIO] Grupo já estava aberto: disparo da rota confirmada iniciado imediatamente.");
    this.emitSnapshot();
    void dispatchCycle?.then(() => {
      if (dispatchedAnalysisId && this.ocrRouteSelection.analysisId !== dispatchedAnalysisId) return;
      const route = dispatchedAnalysisId
        ? this.routeStore.all().find((item) => item.ocr?.analysisId === dispatchedAnalysisId)
        : undefined;
      const sent = Boolean(route?.confirmedCount && route.confirmedCount > 0);
      this.ocrRouteSelection = {
        ...this.ocrRouteSelection,
        dispatchState: sent ? "sent" : "failed",
        dispatchCompletedAt: new Date().toISOString(),
        message: sent
          ? `${route!.confirmedCount} rota(s) enviada(s) com sucesso: ${dispatchedMessages.join(" | ")}.`
          : "O ciclo terminou sem confirmação do WhatsApp. Confira o histórico antes de tentar novamente."
      };
      this.rememberCurrentOcrAnalysis();
      this.emitSnapshot();
    }).catch((error) => {
      if (dispatchedAnalysisId && this.ocrRouteSelection.analysisId !== dispatchedAnalysisId) return;
      this.ocrRouteSelection = {
        ...this.ocrRouteSelection,
        dispatchState: "failed",
        dispatchCompletedAt: new Date().toISOString(),
        message: `O envio não foi confirmado: ${this.getErrorMessage(error)}`
      };
      this.rememberCurrentOcrAnalysis();
      this.emitSnapshot();
    });
    return true;
  }

  private deferOcrDispatchUntilReconnect(
    trigger: "manual" | "automatic",
    interruptedCycleId?: number
  ) {
    if (!this.pendingOcrMessages.length || !this.monitoringEnabled) return;
    const alreadyQueued =
      this.pendingOcrReconnectDispatch?.analysisId === this.lastOcrInsight?.analysisId &&
      this.pendingOcrReconnectDispatch?.interruptedCycleId === interruptedCycleId;
    this.pendingOcrReconnectDispatch = {
      analysisId: this.lastOcrInsight?.analysisId,
      trigger,
      interruptedCycleId,
      queuedAt: new Date().toISOString()
    };
    if (!alreadyQueued) {
      this.logger.warning(
        "[ROMANEIO] A rota ficou pronta durante uma desconexão. Mantive o bot armado e enviarei após o WhatsApp reconectar."
      );
      this.addStatusEvent("reconnecting", "Rota da imagem preservada para envio após reconexão.");
    }
    this.ocrRouteSelection = {
      ...this.ocrRouteSelection,
      dispatchState: "waiting",
      message: "Rota pronta. Aguardando o WhatsApp reconectar para enviar com segurança."
    };
    this.emitSnapshot();
  }

  private async resumeOcrDispatchAfterReconnect() {
    const recovery = this.pendingOcrReconnectDispatch;
    if (!recovery) return false;
    if (!this.monitoringEnabled || !this.pendingOcrMessages.length) {
      this.pendingOcrReconnectDispatch = undefined;
      return false;
    }
    if (this.status !== "connected" || !this.sock) return true;

    if (this.activeSendCycle) {
      const activeCycle = this.activeSendCycle;
      void activeCycle.finally(() => {
        if (
          this.activeSendCycle !== activeCycle &&
          this.pendingOcrReconnectDispatch === recovery &&
          this.status === "connected"
        ) {
          void this.resumeOcrDispatchAfterReconnect();
        }
      }).catch(() => undefined);
      return true;
    }

    const previousAccepted = recovery.analysisId
      ? this.routeStore.all().some((route) => route.ocr?.analysisId === recovery.analysisId && route.confirmedCount > 0)
      : false;
    if (previousAccepted) {
      this.pendingOcrReconnectDispatch = undefined;
      this.logger.success("[ROMANEIO] O WhatsApp confirmou a mensagem anterior; não foi necessário reenviar após reconectar.");
      return true;
    }

    this.prepareSendPlan();
    this.logger.info("[ROMANEIO] WhatsApp reconectado. Retomando a rota preservada da imagem.");
    await this.dispatchPreparedOcrIfGroupOpen(recovery.trigger);
    return true;
  }

  private applyOcrRouteSelection(selected: OcrRouteOption[], mode: "manual" | "automatic") {
    const config = this.configStore.load();
    const violation = mode === "automatic" ? this.findOcrConditionViolation(selected, config) : undefined;
    if (violation) throw new Error(`${violation} Envio automático bloqueado pela condição do bairro.`);
    const messages = selected
      .map((option) => `${config.nomeEnvio} ${option.gaiola}`.trim())
      .filter(Boolean);
    if (!messages.length) throw new Error("Configure o nome de envio antes de confirmar a rota.");

    const activeGroup = this.getActiveMonitoringGroup(config);
    this.pendingOcrMessages = messages;
    this.preparedTargetJid = activeGroup.jid;
    this.preparedMessages = messages;
    if (activeGroup.jid) this.rebuildPreparedRelayMessages(activeGroup.jid, messages);

    this.ocrRouteSelection = {
      ...this.ocrRouteSelection,
      status: "confirmed",
      selectedOptionIds: selected.map((option) => option.id),
      preparedMessages: messages,
      dispatchState: "waiting",
      dispatchGroupName: activeGroup.name || config.grupoAlvoNome || "grupo alvo",
      message: mode === "manual"
        ? "Rotas confirmadas. O bot enviará quando o grupo abrir."
        : `Rota pronta: ${messages.join(" | ")}. Aguardando o grupo abrir para enviar.`
    };
    this.rememberCurrentOcrAnalysis();
    this.logger.success(mode === "manual"
      ? `[ROMANEIO] Cliente confirmou ${selected.length} rota(s): ${messages.join(" | ")}.`
      : `[IA] Bairro preferido selecionado: ${messages.join(" | ")}.`);
  }

  private findOcrConditionViolation(options: OcrRouteOption[], config = this.configStore.load()) {
    const preferences = (config.rotasMonitoradasDetalhadas || []).filter((preference) => preference.enabled !== false);
    for (const option of options) {
      const sameNeighborhood = preferences.filter((candidate) =>
        normalizarTexto(canonicalConfiguredNeighborhood(candidate.bairro)) ===
          normalizarTexto(canonicalConfiguredNeighborhood(option.bairro))
      );
      const compatible = sameNeighborhood.filter((candidate) => !isCentroNeighborhood(candidate.bairro) || !candidate.regiao || option.regiao
        && normalizeRegionIdentity(candidate.regiao) === normalizeRegionIdentity(option.regiao));
      if (sameNeighborhood.length && !compatible.length) {
        return `${option.bairro}: a região ${option.regiao || "não identificada"} não corresponde à região configurada. Envio automático bloqueado.`;
      }
      if (compatible.some((candidate) => {
        if (!candidate.conditionMetric || !(Number(candidate.conditionMax) > 0)) return true;
        const value = candidate.conditionMetric === "packages" ? option.pacotes : option.paradas;
        return value === undefined || value <= Number(candidate.conditionMax);
      })) continue;
      const preference = compatible[0];
      if (!preference?.conditionMetric || !(Number(preference.conditionMax) > 0)) continue;
      const label = preference.conditionMetric === "packages" ? "pacotes" : "paradas";
      const value = preference.conditionMetric === "packages" ? option.pacotes : option.paradas;
      if (value !== undefined && value > Number(preference.conditionMax)) {
        return `${option.bairro}: ${value} ${label}, acima do máximo individual de ${preference.conditionMax}.`;
      }
    }
    return undefined;
  }

  private isExactRomaneioAtDetection(detected: { code?: string; plannedAt?: string; confidence?: number }) {
    if (!this.romaneioStore || !detected.code || !detected.plannedAt || (detected.confidence || 0) < 45) return false;
    const wantedCode = normalizarTexto(detected.code);
    const wantedAt = normalizarTexto(detected.plannedAt);
    return this.romaneioStore.routes().some((route) =>
      normalizarTexto(route.gaiola) === wantedCode && normalizarTexto(route.plannedAt || "") === wantedAt);
  }

  private buildOcrRouteOptions(detected: { route?: string; bairro?: string; code?: string; plannedAt?: string; line?: string; confidence?: number }, allowAmbiguousCodeCorrection = false): OcrRouteOption[] {
    if (!detected.code) return [];
    const fallback = () => [this.toOcrFallbackOption(detected)];
    if (!this.romaneioStore) return fallback();

    try {
      const detectedCodes = getOcrGaiolaCodeCandidates(detected.code, allowAmbiguousCodeCorrection);
      const usePlannedAt = this.isExactRomaneioAtDetection(detected);
      const exactGaiolaOptions = detectedCodes
        .flatMap((code) => this.romaneioStore!.rankForDetected({ gaiola: code, bairro: detected.bairro })
          .filter((route) => !usePlannedAt || normalizarTexto(route.plannedAt || "") === normalizarTexto(detected.plannedAt || ""))
          .filter((route) => this.ocrRouteLooksCompatible(route, { ...detected, code })));

      const matched = exactGaiolaOptions
        .slice(0, 8)
        .map((route, index) => {
          const imageBairro = findNeighborhoodInOcrLine(
            detected.line || "",
            route.bairros.map((bairro) => bairro.nome)
          ) || extractNeighborhoodAfterCity(detected.line || "", route.cidade) || detected.bairro;
          return this.toOcrRouteOption(route, index + 1, imageBairro);
        });
      return matched.length ? matched : fallback();
    } catch (error) {
      this.logger.warning(`[ROMANEIO] Falha ao cruzar a análise da IA com o romaneio: ${this.getErrorMessage(error)}`);
      return fallback();
    }
  }

  private toOcrFallbackOption(detected: { route?: string; bairro?: string; code?: string; confidence?: number }): OcrRouteOption {
    const bairro = detected.bairro || detected.route || "Rota identificada";
    return {
      id: `ocr-sem-romaneio::${bairro}::${detected.code}`,
      rank: 1,
      rota: detected.route || bairro,
      gaiola: detected.code || "",
      bairro,
      distanciaKm: 0,
      pacotes: 0,
      paradas: 0,
      passedFilters: false,
      reasons: ["Sem correspondência no romaneio; não foi possível validar os filtros."],
      score: detected.confidence || 0,
      romaneioMatch: false,
      observation: "Rota identificada na imagem, mas não encontrada ou não correspondente no romaneio."
    };
  }

  private ocrRouteLooksCompatible(route: RomaneioRankedRoute, detected: { route?: string; bairro?: string; code?: string }) {
    const wantedBairro = normalizarTexto(detected.bairro || "");
    const wantedRoute = normalizarTexto(detected.route || "");
    const routeText = normalizarTexto(route.rota || "");
    const routeMatches = !wantedRoute ||
      Boolean(wantedBairro && wantedRoute.includes(wantedBairro)) ||
      routeText.includes(wantedRoute) ||
      wantedRoute.includes(routeText);
    const bairroMatches = !wantedBairro || route.bairros.some((bairro) => {
      const name = normalizarTexto(bairro.nome || "");
      return name.includes(wantedBairro) || wantedBairro.includes(name);
    });
    const gaiolaMatches = Boolean(detected.code) && normalizarTexto(route.gaiola) === normalizarTexto(detected.code);
    return gaiolaMatches && bairroMatches && routeMatches;
  }

  private toOcrRouteOption(route: RomaneioRankedRoute, rank: number, configuredBairro?: string): OcrRouteOption {
    const matchedBairro = configuredBairro
      ? route.bairros.find((item) => normalizarTexto(item.nome) === normalizarTexto(configuredBairro))
      : undefined;
    const bairro = matchedBairro || (configuredBairro ? { nome: configuredBairro, percentualNaRota: 0 } : undefined) || route.bairroMatch || route.bairros[0];
    return {
      id: `${route.rota}::${route.gaiola}::${route.plannedAt || ""}`,
      rank,
      rota: route.rota,
      gaiola: route.gaiola,
      bairro: bairro?.nome || "Bairro não informado",
      bairroPercentual: bairro?.percentualNaRota,
      cidade: route.cidade,
      distanciaKm: route.distanciaKm,
      pacotes: route.pacotes,
      paradas: route.paradas,
      passedFilters: route.passedFilters,
      reasons: route.reasons,
      score: route.score,
      romaneioMatch: true,
      observation: configuredBairro && !matchedBairro
        ? "Bairro lido na imagem; a gaiola existe no romaneio, mas o bairro não consta na composição dessa rota."
        : undefined
    };
  }

  private resetOcrRouteSelection() {
    this.ocrRouteSelection = { status: "idle", options: [] };
  }

  private rememberCurrentOcrAnalysis() {
    this.ocrAnalysisHistoryStore.upsert(this.ocrRouteSelection);
  }

  private cacheRomaneioDocumentCandidates(messages: any[], connectionId: number) {
    if (connectionId !== this.activeConnectionId) return;
    const activeGroup = this.getActiveMonitoringGroup();
    if (!activeGroup.jid) return;

    for (const msg of messages || []) {
      if (msg?.key?.remoteJid !== activeGroup.jid) continue;
      const document = this.getDocumentMessage(msg);
      if (!document) continue;

      const fileName = String(document.fileName || "").trim();
      if (!this.isRomaneioFileName(fileName)) continue;
      if (!this.isMessageFromToday(msg)) continue;

      const id = String(msg?.key?.id || `${fileName}-${msg?.messageTimestamp || Date.now()}`);
      const timestampMs = this.getMessageTimestampMs(msg);
      const periodo = this.getRomaneioPeriod(timestampMs);
      this.romaneioDocumentCandidates.set(id, {
        candidate: {
          id,
          fileName,
          timestamp: new Date(timestampMs).toISOString(),
          periodo,
          periodoLabel: periodo === "manha" ? "Manhã" : "Tarde",
          sender: String(msg?.key?.participant || msg?.pushName || ""),
          groupJid: activeGroup.jid
        },
        message: msg
      });
      void this.persistRomaneioCandidateAutomatically(id);
    }

    this.purgeOldRomaneioCandidates();
  }

  private async persistRomaneioCandidateAutomatically(candidateId: string) {
    if (!this.romaneioStore || !downloadMediaMessage || this.processingRomaneioCandidateIds.has(candidateId)) return;
    const item = this.romaneioDocumentCandidates.get(candidateId);
    if (!item) return;
    const candidateTimestamp = new Date(item.candidate.timestamp).getTime();
    if (candidateTimestamp < this.latestAutomaticRomaneioTimestamp) return;

    this.processingRomaneioCandidateIds.add(candidateId);
    try {
      const buffer = await downloadMediaMessage(
        item.message,
        "buffer",
        {},
        {
          logger: P({ level: "silent" }),
          reuploadRequest: this.sock?.updateMediaMessage
        }
      );
      if (candidateTimestamp < this.latestAutomaticRomaneioTimestamp) return;
      const snapshot = this.romaneioStore.saveUpload(item.candidate.fileName, buffer);
      this.latestAutomaticRomaneioTimestamp = candidateTimestamp;
      this.logger.success(`[ROMANEIO] Arquivo recebido, processado e salvo automaticamente (${item.candidate.periodoLabel}): ${item.candidate.fileName}. Rotas: ${snapshot.status.totalRoutes}.`);
      this.emitSnapshot();
    } catch (error) {
      this.logger.warning(`[ROMANEIO] Não consegui persistir automaticamente ${item.candidate.fileName}: ${this.getErrorMessage(error)}.`);
    } finally {
      this.processingRomaneioCandidateIds.delete(candidateId);
    }
  }

  private getDocumentMessage(msg: any) {
    const message = msg?.message || {};
    return message.documentMessage ||
      message.documentWithCaptionMessage?.message?.documentMessage ||
      message.viewOnceMessage?.message?.documentMessage ||
      message.viewOnceMessageV2?.message?.documentMessage ||
      undefined;
  }

  private isRomaneioFileName(fileName: string) {
    const normalized = normalizarTexto(fileName);
    return normalized.includes("romaneio") && /\.xlsx$/i.test(fileName);
  }

  private isMessageFromToday(msg: any) {
    const date = new Date(this.getMessageTimestampMs(msg));
    const now = new Date();
    return date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
  }

  private getMessageTimestampMs(msg: any) {
    const raw = msg?.messageTimestamp;
    const value = typeof raw === "number" ? raw : Number(raw?.low || raw || 0);
    return value > 10_000_000_000 ? value : value * 1000 || Date.now();
  }

  private getRomaneioPeriod(timestampMs: number): RomaneioCandidate["periodo"] {
    const hour = new Date(timestampMs).getHours();
    return hour >= 4 && hour < 9 ? "manha" : "tarde";
  }

  private purgeOldRomaneioCandidates() {
    const entries = Array.from(this.romaneioDocumentCandidates.entries())
      .filter(([, item]) => this.isMessageFromToday(item.message))
      .sort(([, a], [, b]) => new Date(b.candidate.timestamp).getTime() - new Date(a.candidate.timestamp).getTime())
      .slice(0, ROMANEIO_CANDIDATE_LIMIT);
    this.romaneioDocumentCandidates = new Map(entries);
  }

  private async handleReactions(messages: any[]) {
    const batch = messages || [];
    for (let index = 0; index < batch.length; index += 1) {
      if (this.criticalDispatchInProgress) {
        this.scheduleReactionProcessing(batch.slice(index));
        return;
      }

      const msg = batch[index];
      const reaction = msg?.message?.reactionMessage;
      const reactedMessageId = reaction?.key?.id;
      if (!reaction || !reactedMessageId) continue;

      const senderIdentifiers = await this.getReactionSenderIdentifiers(msg, reaction);
      const senderJid = senderIdentifiers[0] || "";
      const senderPhone = senderIdentifiers.find((identifier) => /^55\d{10,13}$/.test(identifier)) || senderIdentifiers[0] || "";
      const emoji = String(reaction.text || "");
      const action = emoji ? "add" : "remove";
      const timestampMs = Number(reaction.senderTimestampMs || msg.messageTimestamp || Date.now());
      const timestamp = new Date(timestampMs > 9999999999 ? timestampMs : timestampMs * 1000).toISOString();
      const routeReaction: RouteReaction = {
        id: `${reactedMessageId}:${senderJid}:${emoji}:${timestamp}`,
        timestamp,
        emoji,
        senderJid,
        senderPhone,
        senderIdentifiers,
        isAdmin: senderIdentifiers.some((identifier) => this.isAdminPhoneIdentifier(identifier)),
        leaderName: this.getLeaderNameFromIdentifiers(senderIdentifiers)
      };

      const reactedRoute = this.routeStore.all().find((route) => route.sentMessageIds.includes(String(reactedMessageId)));
      if (this.routeStore.recordReactionEvent(String(reactedMessageId), routeReaction, action)) {
        const validatedByLeader = action === "add" && routeReaction.isAdmin && isThumbsUpReaction(emoji) && this.routeStore.validateBySentMessageId(String(reactedMessageId), routeReaction.leaderName || senderPhone || "lider", {
          source: "leader_reaction_1h",
          reason: "Validada automaticamente por reação de joia do líder.",
          reactionAt: timestamp,
          leaderName: routeReaction.leaderName
        });
        this.logger.info(
          action === "remove"
            ? `Reação removida ${routeReaction.isAdmin ? `pelo líder ${routeReaction.leaderName || senderPhone}` : `por ${senderPhone || "remetente desconhecido"}`}. Mantive o evento para auditoria.`
            : routeReaction.isAdmin
            ? validatedByLeader
              ? `Rota validada automaticamente pela joia do líder ${routeReaction.leaderName || senderPhone}.`
              : `Reação do líder ${routeReaction.leaderName || senderPhone} foi encontrada.`
            : `Reação recebida em rota enviada (${senderPhone || "remetente desconhecido"}). IDs: ${senderIdentifiers.join(" / ") || "nenhum"}`
        );
        if (action === "remove" && routeReaction.isAdmin) {
          const incidentRequired = this.routeStore.requireClientIncident(String(reactedMessageId), {
            kind: "leader_reaction_removed",
            message: `O líder ${routeReaction.leaderName || senderPhone || "identificado"} reagiu e removeu a reação. Explique se a rota foi válida ou não para liberar o bot.`
          });
          if (incidentRequired) this.logger.warning("Bot bloqueado para o cliente até explicar a reação removida pelo líder.");
        }
        if (validatedByLeader && reactedRoute) {
          this.emit("route-auto-validated", {
            routeId: reactedRoute.id,
            analysisId: reactedRoute.ocr?.analysisId,
            leaderName: routeReaction.leaderName || senderPhone || "Líder identificado",
            route: this.routeStore.all().find((route) => route.id === reactedRoute.id)
          });
          void this.sendSelfNotification([
            "✅ ROTA CONFIRMADA",
            `Líder: ${routeReaction.leaderName || senderPhone || "identificado"}`,
            `Reação: ${emoji}`,
            `Grupo: ${reactedRoute.groupName}`,
            `Mensagem(ns): ${reactedRoute.messages.join(" | ")}`
          ].join("\n"));
        }
        this.emitSnapshot();
      }
    }
  }

  private handleDeletedMessageNotice(msg: any) {
    const content = msg?.message?.ephemeralMessage?.message || msg?.message;
    const protocol = content?.protocolMessage;
    if (!protocol) {
      // A synchronized history item can already be a tombstone. Its key is
      // the original message author, not evidence of who revoked it.
      this.handleDeletedMessageUpdate({ key: msg?.key, update: { messageStubType: msg?.messageStubType } });
      return;
    }
    const deletedMessageId = String(protocol?.key?.id || protocol?.messageKey?.id || "");
    if (!protocol || !deletedMessageId) return;
    const type = String(protocol?.type ?? protocol?.protocolMessageType ?? "").toLowerCase();
    const looksLikeDelete = type === "0" || type.includes("revoke") || type.includes("delete");
    if (!looksLikeDelete) return;
    this.recordRouteMessageDeletion({ ...protocol.key, ...protocol.messageKey, id: deletedMessageId,
      remoteJid: protocol.key?.remoteJid || protocol.messageKey?.remoteJid || msg.key?.remoteJid }, msg.key, "protocol");
  }

  private handleDeletedMessageUpdate(item: any) {
    const stub = String(item?.update?.messageStubType ?? "").toUpperCase();
    // Baileys turns protocol REVOKE into messages.update (REVOKE = 1).
    // A null message by itself can also be an expiry or unrelated update.
    if (!["1", "132", "REVOKE", "ADMIN_REVOKE"].includes(stub)) return;
    this.recordRouteMessageDeletion(item.key, item.update?.key, "update");
  }

  private recordRouteMessageDeletion(key: any, actorKey: any, source: "protocol" | "update") {
    const messageId = String(key?.id || "");
    if (!messageId) return;
    const actorJid = actorKey?.participant || (actorKey?.fromMe ? this.sock?.user?.id : undefined);
    const actorPhone = this.normalizePhone(String(actorJid || ""));
    const ownPhones = [this.sock?.user?.id, this.sock?.user?.lid].map((id) => this.normalizePhone(String(id || ""))).filter(Boolean);
    // fromMe on the *deleted message* only identifies its original author.
    // Attribute the deletion using the revocation envelope, never that key.
    const actor = actorKey?.fromMe || (actorPhone && ownPhones.includes(actorPhone)) ? "client" : actorJid ? "other" : "unknown";
    if (this.routeStore.recordDeletedMessage(messageId, { groupJid: key.remoteJid, actor, actorJid, source })) {
      this.logger.warning("Mensagem da rota apagada. Validação cancelada; exclusão registrada para ajustar o consumo, sem bloquear o cliente.");
      this.emitSnapshot();
    }
  }

  private getRaceHealth(p95FirstAckMs: number): BotPerformanceMetrics["raceHealth"] {
    if (this.status !== "connected" || !this.currentUserInTargetGroup) return "critical";
    if (!p95FirstAckMs) return "unknown";
    if (p95FirstAckMs <= 250) return "excellent";
    if (p95FirstAckMs <= 700) return "good";
    if (p95FirstAckMs <= 1200) return "poor";
    return "critical";
  }

  private estimateOcrAnalysisSeconds() {
    if (!this.ocrAnalysisDurationsMs.length) return 30;
    const sorted = [...this.ocrAnalysisDurationsMs].sort((a, b) => a - b);
    const p75Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75));
    return Math.max(5, Math.ceil(sorted[p75Index] / 1000) + 2);
  }

  private async getReactionSenderIdentifiers(msg: any, reaction: any) {
    const candidates = [
      msg?.key?.participant,
      msg?.key?.participantPn,
      msg?.key?.participantLid,
      msg?.key?.senderPn,
      msg?.key?.remoteJid,
      msg?.participant,
      msg?.sender,
      msg?.author,
      reaction?.key?.participant,
      reaction?.key?.participantPn,
      reaction?.key?.participantLid,
      reaction?.senderJid,
      reaction?.participant,
      ...this.collectReactionIdentifierCandidates(msg),
      ...this.collectReactionIdentifierCandidates(reaction)
    ];

    const identifiers = new Set<string>();

    for (const item of candidates) {
      const raw = String(item || "");
      const normalized = this.normalizePhone(raw);
      if (normalized) identifiers.add(normalized);

      const phoneFromLid = await this.resolvePhoneFromLid(raw);
      if (phoneFromLid) identifiers.add(phoneFromLid);
    }

    const groupPhone = await this.getReactionPhoneFromGroupMetadata(msg, reaction);
    if (groupPhone) identifiers.add(groupPhone);

    return Array.from(identifiers);
  }

  private async getReactionPhoneFromGroupMetadata(msg: any, reaction: any) {
    const groupJid = String(msg?.key?.remoteJid || reaction?.key?.remoteJid || "");
    const participantIds = [
      msg?.key?.participant,
      msg?.key?.participantLid,
      reaction?.key?.participant,
      reaction?.key?.participantLid,
      reaction?.senderJid,
      reaction?.participant
    ]
      .map((item) => String(item || ""))
      .filter(Boolean);

    if (!groupJid.endsWith("@g.us") || !participantIds.length) return "";

    try {
      const cachedMetadata = this.groupMetadataCache.get(groupJid);
      const cachedPhone = this.findReactionPhoneInMetadata(cachedMetadata, participantIds);
      if (cachedPhone) return cachedPhone;

      // Reações recentes podem trazer o LID antes de o cache do grupo receber o
      // respectivo PN. Atualiza uma vez somente quando o cache não resolveu.
      const metadata = await this.refreshGroupMetadata(groupJid);
      return this.findReactionPhoneInMetadata(metadata, participantIds);
    } catch (error) {
      this.logger.warning(`Não consegui resolver telefone da reação pelo grupo: ${this.getErrorMessage(error)}`);
    }

    return "";
  }

  private findReactionPhoneInMetadata(metadata: any, participantIds: string[]) {
      const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];

      for (const participant of participants) {
        const knownIds = [
          participant?.id,
          participant?.jid,
          participant?.lid,
          participant?.lidJid,
          participant?.phoneNumber,
          participant?.phone_number,
          participant?.pn
        ]
          .map((item) => String(item || ""))
          .filter(Boolean);

        const matches = participantIds.some((incomingId) => {
          const incomingPhone = this.normalizePhone(incomingId);
          return knownIds.some((knownId) => {
            const knownPhone = this.normalizePhone(knownId);
            return knownId === incomingId || Boolean(incomingPhone && knownPhone && incomingPhone === knownPhone);
          });
        });

        if (!matches) continue;

        const phone = [
          participant?.phoneNumber,
          participant?.phone_number,
          participant?.pn,
          participant?.jid,
          participant?.id
        ]
          .map((item) => this.normalizePhone(String(item || "")))
          .find((item) => item.startsWith("55") && item.length >= 12);

        if (phone) return phone;
      }
    return "";
  }

  private async resolvePhoneFromLid(value: string) {
    if (!value || !value.includes("@lid")) return "";

    const lidJid = value.includes("@") ? value : `${this.normalizePhone(value)}@lid`;

    try {
      const mappedPhone = await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
      return this.normalizePhoneFromUnknown(mappedPhone);
    } catch (error) {
      this.logger.warning(`Não consegui traduzir ID interno do WhatsApp para telefone: ${this.getErrorMessage(error)}`);
      return "";
    }
  }

  private collectReactionIdentifierCandidates(input: unknown, depth = 0): string[] {
    if (!input || depth > 3) return [];
    if (typeof input === "string") {
      const phone = this.normalizePhone(input);
      return input.includes("@") || phone.length >= 10 ? [input] : [];
    }
    if (typeof input !== "object") return [];

    const values: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (/timestamp|ephemeral|messageStub/i.test(key)) continue;
      if (typeof value === "string") {
        const phone = this.normalizePhone(value);
        if (value.includes("@") || phone.length >= 10) values.push(value);
      } else if (value && typeof value === "object") {
        values.push(...this.collectReactionIdentifierCandidates(value, depth + 1));
      }
    }
    return values;
  }

  private isAdminPhoneIdentifier(value: string) {
    const phone = this.normalizePhone(value);
    if (!phone) return false;
    return Array.from(this.adminPhoneNumbers).some((adminPhone) => this.samePhone(phone, adminPhone));
  }

  private getLeaderNameFromIdentifiers(values: string[]) {
    for (const value of values) {
      const phone = this.normalizePhone(value);
      for (const [leaderPhone, leaderName] of this.leaderContacts.entries()) {
        if (this.samePhone(phone, leaderPhone)) return leaderName;
      }
    }
    return undefined;
  }

  private samePhone(left: string, right: string) {
    const a = this.normalizePhone(left);
    const b = this.normalizePhone(right);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.startsWith("55") && a.slice(2) === b) return true;
    if (b.startsWith("55") && b.slice(2) === a) return true;
    const aTail = a.slice(-11);
    const bTail = b.slice(-11);
    return aTail.length >= 10 && bTail.length >= 10 && aTail === bTail;
  }

  private enviarMensagensRapidas(
    cycleId: number,
    trigger: RouteDispatch["trigger"] = this.monitoringMode === "test" ? "warmup" : "automatic",
    eventDetectedAt = Date.now(),
    openingSignal?: OpeningSignal
  ) {
    if (!this.preparedTargetJid || !this.preparedMessages.length) {
      this.prepareSendPlan();
    }

    if (!this.monitoringEnabled && trigger === "automatic") {
      this.logger.warning("Abertura ignorada: o bot está parado no painel do cliente.");
      return false;
    }

    if (!this.preparedTargetJid) {
      this.logger.error("Grupo alvo ainda não foi configurado.");
      return false;
    }

    if (!this.preparedMessages.length) {
      this.logger.error("Nenhuma mensagem está pronta.");
      return false;
    }

    let mensagens = [...this.preparedMessages];

    if (this.monitoringMode === "target" && this.preparedTargetDispatchMode !== "ocr" && mensagens.length > MAX_OUTGOING_MESSAGES) {
      mensagens = mensagens.slice(0, MAX_OUTGOING_MESSAGES);
      this.logger.warning(
        `Limite máximo de ${MAX_OUTGOING_MESSAGES} mensagens ativo. Enviando apenas as duas primeiras.`
      );
    }

    if (this.activeSendCycle) {
      this.logger.warning("Já existe um disparo em andamento. O novo gatilho foi ignorado para evitar duplicidade.");
      return false;
    }

    const requiresRecentDuplicateGuard = openingSignal === "already_open";
    if (requiresRecentDuplicateGuard && this.dispatchQueueStore.hasRecentEquivalent(this.preparedTargetJid, mensagens)) {
      this.logger.warning("Disparo imediato bloqueado: esta mesma rota já foi enviada recentemente e o grupo ainda não passou por um novo ciclo de fechamento.");
      return false;
    }

    // Reserve a pista crítica antes até da renovação do envelope.
    this.criticalDispatchInProgress = true;
    this.lastOpeningSignalAt = eventDetectedAt;
    // O envelope precisa nascer agora para ter ID/timestamp novos. Somente a
    // primeira mensagem entra no caminho crítico; as demais são construídas
    // depois que a primeira chamada já alcançou o socket.
    this.rebuildPreparedRelayMessages(this.preparedTargetJid, mensagens, true);
    const sendStartedAt = Date.now();
    const timeline = this.createDispatchTimeline(
      eventDetectedAt,
      sendStartedAt,
      this.monitoringMode === "target" ? "race" : "normal",
      openingSignal
    );
    this.performanceMetrics.activeQueue = mensagens.length;
    this.activeSendCycleId = cycleId;
    this.activeSendTrigger = trigger;
    this.acceptedMessageCountByCycle.set(cycleId, 0);
    if (this.monitoringMode === "target") this.activeSignalProfileTimeline = timeline;
    // Inicia o relay antes das gravações de auditoria.
    const sendCycle =
      this.monitoringMode === "test"
        ? this.sendFastSequence(this.preparedTargetJid, mensagens, cycleId, eventDetectedAt, sendStartedAt, trigger)
        : this.preparedNuclearMode
        ? this.sendNuclearTargetSequence(this.preparedTargetJid, mensagens, cycleId, eventDetectedAt, sendStartedAt, trigger, timeline)
        : this.sendAggressiveTargetSequence(this.preparedTargetJid, mensagens, cycleId, eventDetectedAt, sendStartedAt, trigger, timeline);
    // A faixa seguinte do relay também usa microtasks. Auditoria entra depois,
    // impedindo JSON, histórico e painel de atrasarem a rajada no socket.
    queueMicrotask(() => {
      this.enqueueDispatch(cycleId, this.preparedTargetJid, mensagens, trigger);
      const routeId = this.registerRouteDispatch(cycleId, this.preparedTargetJid, mensagens, trigger, timeline);
      this.attachRaceTrackingRoute(cycleId, routeId);
      this.markQueuedDispatchSending(cycleId, routeId);
    });

    const trackedSendCycle = sendCycle.finally(() => {
      if (this.activeSendCycle === trackedSendCycle) {
        this.activeSendCycle = undefined;
        if (this.activeSendCycleId === cycleId) this.activeSendCycleId = undefined;
        if (this.activeSendTrigger === trigger) this.activeSendTrigger = undefined;
        this.criticalDispatchInProgress = false;
      }
    });
    this.activeSendCycle = trackedSendCycle;

    const timedAnalysisId = this.ocrRouteSelection.analysisId;
    const timedAnalysis = this.ocrRouteSelection.timing;
    if (this.monitoringMode === "target" && this.preparedTargetDispatchMode === "ocr" && timedAnalysisId && timedAnalysis) {
      void trackedSendCycle.finally(() => {
        if (this.ocrRouteSelection.analysisId !== timedAnalysisId) return;
        const finishedAt = Date.now();
        const startedAt = Date.parse(timedAnalysis.startedAt) || sendStartedAt;
        const completedTiming = {
          ...timedAnalysis,
          dispatchMs: Math.max(0, finishedAt - sendStartedAt),
          totalMs: Math.max(0, finishedAt - startedAt)
        };
        this.ocrRouteSelection = { ...this.ocrRouteSelection, timing: completedTiming };
        this.rememberCurrentOcrAnalysis();
        this.logger.success(`[ROMANEIO] Tempo total da imagem até o último envio: ${completedTiming.totalMs}ms.`);
        this.emitSnapshot();
      }).catch(() => undefined);
    }

    this.logger.info(
      `${this.monitoringMode === "test" ? "Aquecimento real do teste" : this.preparedNuclearMode ? "Modo nuclear máximo" : "Modo instantâneo agressivo"}: ${mensagens.length} mensagens preparadas: ${mensagens.join(" | ")}`
    );
    return true;
  }

  private ensurePreparedRelayMessages(jid: string, mensagens: string[]) {
    if (!this.sock || !jid) return;
    const signature = this.getRelaySignature(jid, mensagens);
    if (
      this.preparedRelaySignature === signature &&
      this.preparedRelayMessages.length === mensagens.length
    ) {
      return;
    }
    this.rebuildPreparedRelayMessages(jid, mensagens);
  }

  private rebuildPreparedRelayMessages(jid: string, mensagens: string[], firstOnly = false) {
    if (!this.sock || !jid) {
      this.preparedRelayMessages = [];
      this.preparedRelaySignature = "";
      this.preparedRelayBuiltAt = 0;
      return;
    }
    const messagesToBuild = firstOnly ? mensagens.slice(0, 1) : mensagens;
    this.preparedRelayMessages = messagesToBuild.map((mensagem) => this.buildRelayTextMessage(this.sock, jid, mensagem));
    this.preparedRelaySignature = this.getRelaySignature(jid, mensagens);
    this.preparedRelayBuiltAt = Date.now();
  }

  private getRelaySignature(jid: string, mensagens: string[]) {
    return `${jid}::${mensagens.join("\u001f")}`;
  }

  private registerRouteDispatch(
    cycleId: number,
    jid: string,
    mensagens: string[],
    trigger: RouteDispatch["trigger"] = this.monitoringMode === "test" ? "warmup" : "automatic",
    dispatchTimeline?: RouteDispatchTimeline
  ) {
    const config = this.configStore.load();
    const sentMessageIds = this.preparedRelayMessages.map((item) => String(item?.key?.id || "")).filter(Boolean);
    const route = this.routeStore.create({
      id: `${Date.now()}-${cycleId}`,
      clientEmail: this.clientEmail,
      groupJid: jid,
      groupName: this.monitoringMode === "test" ? config.grupoTesteNome || jid : config.grupoAlvoNome || jid,
      mode: this.monitoringMode,
      trigger,
      messages: mensagens,
      sentMessageIds,
      confirmedCount: 0,
      totalCount: mensagens.length,
      status: "sending",
      dispatchTimeline,
      ocr: this.monitoringMode === "target" && config.targetDispatchMode === "ocr" ? this.lastOcrInsight : undefined
    });
    this.activeRouteByCycle.set(cycleId, route.id);
    this.routeMessageIdsByCycle.set(cycleId, sentMessageIds);
    return route.id;
  }

  private updateRouteDispatch(cycleId: number, confirmedCount: number, totalCount: number, dispatchTimeline?: RouteDispatchTimeline, finalizeQueue = false) {
    const routeId = this.activeRouteByCycle.get(cycleId);
    if (!routeId) return;
    const previousRoute = this.routeStore.all().find((route) => route.id === routeId);
    const patch: Parameters<RouteStore["update"]>[1] = {
      confirmedCount,
      status: confirmedCount === totalCount ? "sent" : confirmedCount > 0 ? "partial" : "failed"
    };
    const sentMessageIds = this.routeMessageIdsByCycle.get(cycleId);
    if (sentMessageIds?.length) patch.sentMessageIds = sentMessageIds;
    if (dispatchTimeline) patch.dispatchTimeline = dispatchTimeline;
    this.routeStore.update(routeId, patch);
    if (finalizeQueue) this.markQueuedDispatchFinished(cycleId, confirmedCount, totalCount);
    if (finalizeQueue && confirmedCount > 0 && previousRoute?.mode === "target" && previousRoute.status === "sending") {
      void this.sendSelfNotification([
        "🚀 DISPARO REALIZADO",
        `Grupo: ${previousRoute.groupName}`,
        `Confirmadas pelo WhatsApp: ${confirmedCount}/${totalCount}`,
        `Mensagem(ns): ${previousRoute.messages.join(" | ")}`
      ].join("\n"));
    }
    this.emitSnapshot();
  }

  private async sendSelfNotification(text: string) {
    const sock = this.sock;
    const ownJid = String(sock?.user?.id || "").replace(/:\d+@/, "@");
    if (!sock?.sendMessage || !ownJid || this.status !== "connected") {
      this.logger.warning("Aviso pessoal não enviado: número conectado indisponível.");
      return false;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await sock.sendMessage(ownJid, { text });
        this.logger.success("Aviso enviado ao WhatsApp do próprio cliente.");
        return true;
      } catch (error) {
        if (attempt === 3) {
          this.logger.warning(`Não consegui enviar o aviso pessoal: ${this.getErrorMessage(error)}.`);
          return false;
        }
        await this.delay(300 * attempt);
      }
    }
    return false;
  }

  private appendRouteMessageId(cycleId: number, messageId?: string) {
    if (!messageId) return;
    const current = this.routeMessageIdsByCycle.get(cycleId) || [];
    if (current.includes(messageId)) return;
    const next = [...current, messageId];
    this.routeMessageIdsByCycle.set(cycleId, next);
    const routeId = this.activeRouteByCycle.get(cycleId);
    if (routeId) {
      this.routeStore.update(routeId, { sentMessageIds: next });
    }
  }

  private async sendFastSequence(jid: string, mensagens: string[], cycleId: number, eventDetectedAt = Date.now(), sendStartedAt = Date.now(), trigger: RouteDispatch["trigger"] = "warmup") {
    try {
      const sock = this.sock;
      if (!sock) {
        this.logger.error("Não há conexão ativa no momento do disparo.");
        this.updateRouteDispatch(cycleId, 0, mensagens.length, undefined, true);
        this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed: 0, total: mensagens.length, trigger, mode: this.monitoringMode });
        return;
      }

      if (mensagens.length === 1) {
        const sent = await this.sendSingleInstant(sock, jid, mensagens[0], cycleId);
        if (sent) {
          this.logger.success("Disparo concluído: 1/1 mensagem confirmada.");
        } else {
          this.logger.warning("Disparo terminou com atenção: 0/1 mensagem confirmada.");
        }
        this.updateRouteDispatch(cycleId, sent ? 1 : 0, 1, undefined, true);
        this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed: sent ? 1 : 0, total: 1, trigger, mode: this.monitoringMode });
        return;
      }

      let confirmed = 0;

      for (const [index, mensagem] of mensagens.entries()) {
        const messageNumber = index + 1;
        if (cycleId !== this.sendCycleId || (!this.monitoringEnabled && trigger === "automatic")) break;

        try {
          await this.relayPreparedTextMessage(sock, jid, mensagem, index);
          this.logger.success(`Mensagem ${messageNumber} confirmada: ${mensagem}`);
          confirmed += 1;
        } catch (error) {
          const message = this.getErrorMessage(error);
          this.logger.warning(`Mensagem ${messageNumber} falhou no tiro instantâneo (${message}). Retentando...`);

          if (!this.isRetryableSendError(message)) {
            this.logger.error(`Erro ao enviar mensagem ${messageNumber}: ${message}`);
            break;
          }

          const retried = await this.sendMessageWithRetry(jid, mensagem, messageNumber, cycleId, true);
          if (!retried) {
            break;
          }

          confirmed += 1;
        }

        if (messageNumber === 1 && confirmed === 1 && mensagens.length > 1) {
          this.logger.info("Mensagem 1 confirmada. Enviando mensagem 2 imediatamente.");
        }
      }

      if (confirmed === mensagens.length) {
        this.logger.success(`Disparo concluído: ${confirmed}/${mensagens.length} mensagens confirmadas.`);
      } else {
        this.logger.warning(`Disparo terminou com atenção: ${confirmed}/${mensagens.length} mensagens confirmadas.`);
      }
      this.updateRouteDispatch(cycleId, confirmed, mensagens.length, undefined, true);
      this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed, total: mensagens.length, trigger, mode: this.monitoringMode });
    } catch (error) {
      this.logger.error(`Erro inesperado no disparo turbo: ${this.getErrorMessage(error)}`);
      this.updateRouteDispatch(cycleId, 0, mensagens.length, undefined, true);
      this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed: 0, total: mensagens.length, trigger, mode: this.monitoringMode });
    }
  }

  private async sendNuclearTargetSequence(
    jid: string,
    mensagens: string[],
    cycleId: number,
    eventDetectedAt = Date.now(),
    sendStartedAt = Date.now(),
    trigger: RouteDispatch["trigger"] = "automatic",
    timeline = this.createDispatchTimeline(eventDetectedAt, sendStartedAt, "race")
  ) {
    this.logger.info("☢️ Modo nuclear máximo: rajada paralela imediata após evento de abertura.");
    await this.sendAggressiveTargetSequence(jid, mensagens, cycleId, eventDetectedAt, sendStartedAt, trigger, timeline);
  }

  private async sendAggressiveTargetSequence(
    jid: string,
    mensagens: string[],
    cycleId: number,
    eventDetectedAt = Date.now(),
    sendStartedAt = Date.now(),
    trigger: RouteDispatch["trigger"] = "automatic",
    timeline = this.createDispatchTimeline(eventDetectedAt, sendStartedAt, "race")
  ) {
    let dispatchGateToken = "";
    let dispatchGateSettled = false;
    try {
      const sock = this.sock;
      if (!sock) {
        this.logger.error("Não há conexão ativa no momento do disparo.");
        this.updateRouteDispatch(cycleId, 0, mensagens.length, timeline, true);
        this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed: 0, total: mensagens.length, timeline, trigger, mode: this.monitoringMode });
        this.stopMonitoringAfterTargetDispatch(cycleId);
        return;
      }

      const priority = this.getDispatchPriorityProfile();
      timeline.dispatchPriority = priority;
      const coordinatedByServer = this.shouldApplyDispatchPriorityDelay(trigger) && Boolean(this.dispatchGateRequester);
      if (coordinatedByServer) {
        const grant = await this.dispatchGateRequester!({
          clientEmail: this.clientEmail,
          groupKey: jid,
          eventDetectedAt,
          eventKey: this.getDispatchRaceEventKey(),
          targetDispatchMode: this.preparedTargetDispatchMode
        });
        dispatchGateToken = grant.token;
        if (cycleId !== this.sendCycleId || (trigger === "automatic" && !this.monitoringEnabled)) {
          throw new Error("O ciclo do grupo foi encerrado antes do envio.");
        }
      } else if (this.shouldApplyDispatchPriorityDelay(trigger) && priority.delayMs > 0) {
        timeline.priorityDelayMs = priority.delayMs;
        this.addTimelineEvent(timeline, "Prioridade de corrida aplicada", Date.now(), "info", `Nível ${priority.level}: ${priority.delayMs}ms`);
        await this.delay(priority.delayMs);
        if (cycleId !== this.sendCycleId || (trigger === "automatic" && !this.monitoringEnabled)) {
          throw new Error("Ciclo cancelado durante prioridade de corrida.");
        }
      }

      const speculativeSecondLane = mensagens.length > 1 && this.shouldUseSpeculativeSecondLane(trigger);
      timeline.secondLaneMode = speculativeSecondLane ? "speculative" : "ack-gated";
      let releaseFirstMessageLane = () => undefined;
      const firstMessageLane = new Promise<void>((resolve) => {
        releaseFirstMessageLane = resolve;
      });
      const jobs = mensagens.map((mensagem, index) => {
        const messageNumber = index + 1;
        const fullMessage =
          this.preparedRelayMessages[index] ||
          this.buildRelayTextMessage(sock, jid, mensagem);

        const firstAttempt = (async () => {
          if (cycleId !== this.sendCycleId || (trigger === "automatic" && !this.monitoringEnabled)) {
            throw new Error("Ciclo cancelado pelo painel ou por nova abertura.");
          }
          if (index > 0) await firstMessageLane;
          const baseStaggerMs = trigger === "manual" ? MANUAL_ROUTE_SELECTION_STAGGER_MS : TARGET_PARALLEL_STAGGER_MS;
          // A primeira mensagem decide a corrida e nunca deve esperar. Se o WhatsApp
          // já recusou rajadas, a adaptação protege apenas as mensagens seguintes.
          const adaptiveStaggerMs =
            index > 0 && trigger === "automatic" && this.monitoringMode === "target"
              ? this.adaptiveOpeningSettleMs
              : 0;
          const staggerMs = index === 0 ? 0 : baseStaggerMs * index + adaptiveStaggerMs;
          if (staggerMs > 0) await this.delay(staggerMs);
          if (cycleId !== this.sendCycleId || this.stopping || this.sock !== sock || (trigger === "automatic" && !this.monitoringEnabled)) {
            throw new Error("Ciclo cancelado antes do relay.");
          }
          const calledAt = Date.now();
          if (!timeline.firstRelayCalledAt) {
            timeline.firstRelayCalledAt = new Date(calledAt).toISOString();
            timeline.firstRelayCallMs = Math.max(0, calledAt - sendStartedAt);
          }
          this.addTimelineEvent(timeline, `Relay ${messageNumber} chamado`, calledAt, "info", String(fullMessage?.key?.id || ""));
          this.trackOutboundRaceMessage(String(fullMessage?.key?.id || ""), cycleId, timeline, calledAt);
          const relay = this.relayPreparedMessage(sock, jid, fullMessage);
          if (index === 0 && speculativeSecondLane) releaseFirstMessageLane();
          await relay;
          return String(fullMessage?.key?.id || "");
        })();

        const finalPromise = firstAttempt
          .catch((error) =>
            this.retryTargetMessageAfterFailure(jid, mensagens[index], messageNumber, cycleId, error, timeline)
          )
          .then((messageId) => {
            if (index === 0 && dispatchGateToken) {
              dispatchGateSettled = true;
              if (messageId) this.dispatchGateRelayReporter?.(dispatchGateToken, this.clientEmail, Date.now());
              else this.dispatchGateFailureReporter?.(dispatchGateToken, this.clientEmail, Date.now());
            }
            if (!messageId) return messageId;
            const acceptedCount = (this.acceptedMessageCountByCycle.get(cycleId) || 0) + 1;
            this.acceptedMessageCountByCycle.set(cycleId, acceptedCount);
            if (this.pendingOcrReconnectDispatch?.interruptedCycleId === cycleId) {
              this.pendingOcrReconnectDispatch = undefined;
              this.logger.success(
                "[ROMANEIO] O WhatsApp aceitou a mensagem antes de concluir a queda. Reenvio após reconexão cancelado."
              );
            }
            const ackAt = Date.now();
            if (!timeline.firstAckAt) {
              timeline.firstAckAt = new Date(ackAt).toISOString();
              timeline.firstAckMs = Math.max(0, ackAt - sendStartedAt);
              timeline.ackWaitMs = Math.max(0, ackAt - new Date(timeline.firstRelayCalledAt || timeline.sendStartedAt).getTime());
            }
            this.appendRouteMessageId(cycleId, messageId);
            this.addTimelineEvent(timeline, `Mensagem ${messageNumber} confirmada`, ackAt, "success");
            this.logger.info(`Mensagem alvo ${messageNumber} aceita pelo servidor do WhatsApp. Aguardando retorno no grupo.`);
            return messageId;
          })
          .catch((error) => {
            if (index === 0 && dispatchGateToken && !dispatchGateSettled) {
              dispatchGateSettled = true;
              this.dispatchGateFailureReporter?.(dispatchGateToken, this.clientEmail, Date.now());
            }
            throw error;
          });
        if (index === 0) {
          void finalPromise.then(releaseFirstMessageLane, releaseFirstMessageLane);
        }

        // Observe falhas imediatamente; o relatório final preserva o motivo
        // mesmo enquanto outra mensagem aguarda confirmação.
        const settledFinalPromise = Promise.allSettled([finalPromise]).then(([result]) => result);

        const timedInitialAttempt = index === 0
          ? this.withTimeout(firstAttempt, TARGET_ACK_TIMEOUT_MS)
          : firstMessageLane.then(() => this.withTimeout(firstAttempt, TARGET_ACK_TIMEOUT_MS));
        const initialPromise = timedInitialAttempt.then(
          () => ({ status: "acked" as const, messageNumber }),
          (error) => {
            const message = this.getErrorMessage(error);
            if (message === "ack-timeout") {
              timeline.timeoutUsed = true;
              this.addTimelineEvent(timeline, `ACK ${messageNumber} pendente`, Date.now(), "warning", `${TARGET_ACK_TIMEOUT_MS}ms sem confirmação`);
              return { status: "timeout" as const, messageNumber };
            }
            this.addTimelineEvent(timeline, `Falha rápida ${messageNumber}`, Date.now(), "warning", message);
            return { status: "failed" as const, messageNumber, error };
          }
        );

        return { initialPromise, finalPromise: settledFinalPromise };
      });

      const initialResults = await Promise.all(jobs.map((job) => job.initialPromise));
      const quickConfirmed = initialResults.filter((result) => result.status === "acked").length;
      const pendingAck = initialResults.filter((result) => result.status === "timeout").length;
      const quickFailed = initialResults.filter((result) => result.status === "failed").length;

      this.logger.info(
        `Modo corrida: chamadas feitas em ${Date.now() - sendStartedAt}ms. ACK rápido ${quickConfirmed}/${mensagens.length}, pendente ${pendingAck}, falha rápida ${quickFailed}.`
      );
      this.performanceMetrics.activeQueue = pendingAck + quickFailed;
      this.addTimelineEvent(timeline, "Chamadas finalizadas", Date.now(), pendingAck ? "warning" : "success", `${quickConfirmed}/${mensagens.length} ACK rápido`);
      this.updateRouteDispatch(cycleId, quickConfirmed, mensagens.length, timeline);
      this.emitSnapshot();
      this.addStatusEvent("dispatch", `${triggerLabelForEvent(trigger)} chamado: ${quickConfirmed}/${mensagens.length} ACK rápido, ${pendingAck} pendente.`);
      this.stopMonitoringAfterTargetDispatch(cycleId);

      void this.finishTargetDispatchInBackground({
        jobs: jobs.map((job) => job.finalPromise),
        cycleId,
        total: mensagens.length,
        eventDetectedAt,
        sendStartedAt,
        trigger,
        timeline
      }).catch((error) => {
        this.logger.error(`Falha ao concluir histórico do disparo: ${this.getErrorMessage(error)}`);
      });
    } catch (error) {
      if (dispatchGateToken && !dispatchGateSettled) {
        dispatchGateSettled = true;
        this.dispatchGateFailureReporter?.(dispatchGateToken, this.clientEmail, Date.now());
      }
      this.logger.error(`Erro inesperado no disparo agressivo: ${this.getErrorMessage(error)}`);
      this.addTimelineEvent(timeline, "Erro inesperado", Date.now(), "error", this.getErrorMessage(error));
      this.updateRouteDispatch(cycleId, 0, mensagens.length, timeline, true);
      this.updateAdaptiveOpeningSettle(timeline);
      this.recordDispatchMetrics({ eventDetectedAt, sendStartedAt, sendFinishedAt: Date.now(), confirmed: 0, total: mensagens.length, timeline, trigger, mode: this.monitoringMode });
      this.stopMonitoringAfterTargetDispatch(cycleId);
      if (this.activeSignalProfileTimeline === timeline) this.activeSignalProfileTimeline = undefined;
    }
  }

  private async finishTargetDispatchInBackground(input: {
    jobs: Promise<PromiseSettledResult<string | false>>[];
    cycleId: number;
    total: number;
    eventDetectedAt: number;
    sendStartedAt: number;
    trigger: RouteDispatch["trigger"];
    timeline: RouteDispatchTimeline;
  }) {
    const results = await Promise.all(input.jobs);
    let confirmed = 0;
    results.forEach((result, index) => {
      const messageNumber = index + 1;
      if (result.status === "fulfilled" && result.value) {
        confirmed += 1;
        return;
      }

      const message = result.status === "rejected" ? this.getErrorMessage(result.reason) : "Não confirmou após retry.";
      this.addTimelineEvent(input.timeline, `Mensagem ${messageNumber} falhou`, Date.now(), "error", message);
      this.logger.warning(`Mensagem alvo ${messageNumber} não confirmou no modo corrida: ${message}`);
    });

    const finishedAt = Date.now();
    input.timeline.finishedAt = new Date(finishedAt).toISOString();
    input.timeline.totalDurationMs = Math.max(0, finishedAt - input.sendStartedAt);

    if (confirmed === input.total) {
      this.logger.info(
        `Confirmação final do WhatsApp em ${input.timeline.totalDurationMs}ms: ${confirmed}/${input.total}. ` +
        `Primeiro relay saiu em ${input.timeline.firstRelayCallMs ?? 0}ms.`
      );
    } else {
      this.logger.warning(`Disparo modo corrida terminou com atenção em ${input.timeline.totalDurationMs}ms: ${confirmed}/${input.total}.`);
    }

    this.updateRouteDispatch(input.cycleId, confirmed, input.total, input.timeline, true);
    this.updateAdaptiveOpeningSettle(input.timeline);
    this.recordDispatchMetrics({
      eventDetectedAt: input.eventDetectedAt,
      sendStartedAt: input.sendStartedAt,
      sendFinishedAt: finishedAt,
      confirmed,
      total: input.total,
      timeline: input.timeline,
      trigger: input.trigger,
      mode: this.monitoringMode
    });
    this.addStatusEvent("dispatch", `${triggerLabelForEvent(input.trigger)} confirmado: ${confirmed}/${input.total}.`);
    this.activeRouteByCycle.delete(input.cycleId);
    this.routeMessageIdsByCycle.delete(input.cycleId);
    this.acceptedMessageCountByCycle.delete(input.cycleId);
    if (this.activeSignalProfileTimeline === input.timeline) this.activeSignalProfileTimeline = undefined;
  }

  private async retryTargetMessageAfterFailure(
    jid: string,
    mensagem: string,
    messageNumber: number,
    cycleId: number,
    error: unknown,
    timeline: RouteDispatchTimeline
  ): Promise<string | false> {
    if (cycleId !== this.sendCycleId || this.stopping) return false;
    const firstMessage = this.getErrorMessage(error);
    if (this.isConnectionUnavailableError(firstMessage)) {
      this.deferOcrDispatchUntilReconnect(
        this.activeSendTrigger === "manual" ? "manual" : "automatic",
        cycleId
      );
      if (cycleId === this.sendCycleId) this.sendCycleId += 1;
      return false;
    }
    if (!this.isRetryableSendError(firstMessage)) throw error;

    timeline.retryUsed = true;
    const firstNotAcceptable = this.isNotAcceptableError(firstMessage);
    if (firstNotAcceptable) {
      timeline.notAcceptableCount += 1;
      this.scheduleNotAcceptableDiagnosis(jid, cycleId);
    }

    const delays = firstNotAcceptable ? NOT_ACCEPTABLE_RETRY_DELAYS_MS : GENERIC_RETRY_DELAYS_MS;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (cycleId !== this.sendCycleId) return false;
      await this.delay(delays[attempt]);
      if (cycleId !== this.sendCycleId || this.stopping) return false;
      try {
        this.addTimelineEvent(timeline, `Retry ${messageNumber}.${attempt + 1}`, Date.now(), "info", firstMessage);
        if (!this.sock) throw new Error("Não há conexão ativa para retry.");
        const sent = await this.relayTextMessage(this.sock, jid, mensagem);
        const messageId = String(sent?.key?.id || "");
        this.appendRouteMessageId(cycleId, messageId);
        return messageId || false;
      } catch (nextError) {
        const nextMessage = this.getErrorMessage(nextError);
        if (this.isNotAcceptableError(nextMessage)) {
          timeline.notAcceptableCount += 1;
          this.scheduleNotAcceptableDiagnosis(jid, cycleId);
        }
        if (!this.isRetryableSendError(nextMessage) || attempt === delays.length - 1) {
          throw nextError;
        }
      }
    }

    return false;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ack-timeout")), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private stopMonitoringAfterTargetDispatch(cycleId: number) {
    if (this.targetSimulationCycles.has(cycleId)) return;
    if (this.monitoringMode !== "target") return;
    if (!this.monitoringEnabled) return;
    if (this.pendingOcrReconnectDispatch?.interruptedCycleId === cycleId) {
      this.logger.warning("[ROMANEIO] Disparo interrompido pela conexão. Bot continua armado aguardando reconexão.");
      this.emitSnapshot();
      return;
    }

    this.monitoringEnabled = false;
    this.armedAt = undefined;
    this.invalidateInternalWarmState();
    this.clearHealthCheckTimer();
    this.clearWarmKeepAliveTimer();
    this.logger.warning("Disparo no grupo alvo finalizado. Bot parado automaticamente para evitar mensagens duplicadas.");
    this.emitSnapshot();
  }

  private async sendSingleInstant(sock: any, jid: string, mensagem: string, cycleId: number) {
    if (cycleId !== this.sendCycleId) return false;

    try {
      await this.relayPreparedTextMessage(sock, jid, mensagem, 0);
      this.logger.success(`Mensagem 1 confirmada: ${mensagem}`);
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.logger.warning(`Mensagem 1 falhou no tiro instantâneo (${message}). Retentando...`);

      if (!this.isRetryableSendError(message)) {
        this.logger.error(`Erro ao enviar mensagem 1: ${message}`);
        return false;
      }

      return this.sendMessageWithRetry(jid, mensagem, 1, cycleId, true);
    }
  }

  private async sendBurstMessage(
    jid: string,
    mensagem: string,
    messageNumber: number,
    cycleId: number,
    initialDelay: number
  ) {
    if (initialDelay > 0) {
      await this.delay(initialDelay);
    }

    if (cycleId !== this.sendCycleId) return false;

    const sent = await this.sendMessageWithRetry(jid, mensagem, messageNumber, cycleId);
    if (!sent) {
      this.logger.warning(
        `Mensagem ${messageNumber} não confirmou mesmo na rajada instantânea.`
      );
    }

    return sent;
  }

  private async relayTextMessage(sock: any, jid: string, mensagem: string) {
    const fullMessage = this.buildRelayTextMessage(sock, jid, mensagem);
    await this.relayPreparedMessage(sock, jid, fullMessage);
    return fullMessage;
  }

  private async relayPreparedTextMessage(sock: any, jid: string, mensagem: string, index: number) {
    const fullMessage = this.preparedRelayMessages[index] || this.buildRelayTextMessage(sock, jid, mensagem);
    await this.relayPreparedMessage(sock, jid, fullMessage);
    return fullMessage;
  }

  private trackOutboundRaceMessage(messageId: string, cycleId: number, timeline: RouteDispatchTimeline, relayCalledAt: number) {
    if (!messageId) return;
    this.outboundRaceTracking.set(messageId, { cycleId, timeline, relayCalledAt, routeId: this.activeRouteByCycle.get(cycleId) });
    const cleanupTimer = setTimeout(() => this.outboundRaceTracking.delete(messageId), 60_000);
    cleanupTimer.unref?.();
  }

  private attachRaceTrackingRoute(cycleId: number, routeId: string) {
    for (const tracking of this.outboundRaceTracking.values()) {
      if (tracking.cycleId === cycleId) tracking.routeId = routeId;
    }
  }

  private recordOutboundGroupEcho(messages: any[]) {
    for (const message of messages) {
      const messageId = String(message?.key?.id || "");
      const tracking = this.outboundRaceTracking.get(messageId);
      if (!tracking) continue;
      const receivedAt = Date.now();
      const timeline = tracking.timeline;
      if (!timeline.firstGroupEchoAt) {
        timeline.firstGroupEchoAt = new Date(receivedAt).toISOString();
        timeline.firstGroupEchoMs = Math.max(0, receivedAt - new Date(timeline.sendStartedAt).getTime());
        this.performanceMetrics.lastFirstGroupEchoMs = timeline.firstGroupEchoMs;
        this.addTimelineEvent(timeline, "Mensagem retornou pelo WhatsApp", receivedAt, "success", `${receivedAt - tracking.relayCalledAt}ms após o relay`);
        this.logger.success(`Entrega confirmada no grupo pelo retorno do WhatsApp em ${receivedAt - tracking.relayCalledAt}ms.`);
        if (tracking.routeId) this.routeStore.update(tracking.routeId, { dispatchTimeline: timeline });
        this.emitSnapshot();
      }
      this.outboundRaceTracking.delete(messageId);
    }
  }

  private buildRelayTextMessage(sock: any, jid: string, mensagem: string) {
    const messageId = generateMessageIDV2(sock.user?.id);
    return generateWAMessageFromContent(
      jid,
      { conversation: mensagem },
      {
        userJid: sock.user?.id,
        messageId,
        timestamp: new Date()
      }
    );
  }

  private async relayPreparedMessage(sock: any, jid: string, fullMessage: any) {
    await sock.relayMessage(jid, fullMessage.message, {
      messageId: fullMessage.key.id,
      useUserDevicesCache: true,
      useCachedGroupMetadata: true
    });
  }

  private montarMensagens(config = this.configStore.load()) {
    const { nomeEnvio, codigosMensagensAlvo, codigosMensagensTeste } = config;
    this.mensagensProntasAlvo = (codigosMensagensAlvo || [])
      .map((codigo) => `${nomeEnvio} ${codigo}`)
      .filter(Boolean);
    this.mensagensProntasTeste = (codigosMensagensTeste || [])
      .map((codigo) => `${nomeEnvio} ${codigo}`)
      .filter(Boolean);
  }

  private syncMessagesFromConfig(config = this.configStore.load()) {
    // reload messages from config for both alvo and teste
    this.montarMensagens(config);
  }

  private prepareSendPlan() {
    const config = this.configStore.load();
    this.preparedNuclearMode = Boolean(config.nuclearMode);
    this.preparedTargetDispatchMode = config.targetDispatchMode;
    this.syncMessagesFromConfig(config);
    const activeGroup = this.getActiveMonitoringGroup(config);

    this.preparedTargetJid = activeGroup.jid;
    this.preparedMessages = this.monitoringMode === "test"
      ? this.buildWarmupMessages()
      : config.targetDispatchMode === "ocr"
      ? this.pendingOcrMessages.length
      ? [...this.pendingOcrMessages]
      : []
      : [...this.mensagensProntasAlvo];

    if (this.monitoringMode === "target" && config.targetDispatchMode !== "ocr" && this.preparedMessages.length > MAX_OUTGOING_MESSAGES) {
      this.preparedMessages = this.preparedMessages.slice(0, MAX_OUTGOING_MESSAGES);
      this.logger.warning(
        `Limite máximo de ${MAX_OUTGOING_MESSAGES} mensagens ativo. As duas primeiras mensagens serão preparadas para envio.`
      );
    }

    if (this.sock && this.preparedTargetJid) {
      this.ensurePreparedRelayMessages(this.preparedTargetJid, this.preparedMessages);
    } else {
      this.preparedRelayMessages = [];
      this.preparedRelaySignature = "";
      this.preparedRelayBuiltAt = 0;
    }

    return Boolean(
      this.preparedTargetJid &&
      (this.preparedMessages.length || (this.monitoringMode === "target" && config.targetDispatchMode === "ocr"))
    );
  }

  private resetWarmupState() {
    this.warmupMessagesSent = 0;
    this.warmupCompleted = false;
    this.emitSnapshot();
  }

  private async sendMessageWithRetry(
    jid: string,
    mensagem: string,
    messageNumber: number,
    cycleId: number,
    skipInstantAttempt = false
  ) {
    const config = this.configStore.load();
    const minDelay = Math.max(0, config.minSendDelayMs || 0);
    let delays = [minDelay, 10, 20, 35, 55, 85, 130, 210, 320]
      .filter((delay, index, items) => delay > 0 || index === 0)
      .filter((delay, index, items) => items.indexOf(delay) === index);

    for (let attempt = skipInstantAttempt ? 1 : 0; attempt <= delays.length; attempt += 1) {
      if (cycleId !== this.sendCycleId) {
        this.logger.warning(`Mensagem ${messageNumber} cancelada porque começou outro ciclo de abertura.`);
        return false;
      }

      if (attempt > 0) {
        await this.delay(delays[attempt - 1]);
      }

      if (cycleId !== this.sendCycleId) {
        this.logger.warning(`Mensagem ${messageNumber} cancelada porque começou outro ciclo de abertura.`);
        return false;
      }

      try {
        if (attempt > 0) {
          this.logger.info(`Tentando novamente mensagem ${messageNumber} (${attempt + 1}/${delays.length + 1}).`);
        }

        await this.relayTextMessage(this.sock, jid, mensagem);
        this.logger.success(`Mensagem ${messageNumber} confirmada: ${mensagem}`);
        return true;
      } catch (error) {
        const message = this.getErrorMessage(error);

        if (!this.isRetryableSendError(message) || attempt === delays.length) {
          this.logger.error(`Erro ao enviar mensagem ${messageNumber}: ${message}`);
          if (this.isNotAcceptableError(message)) {
            this.scheduleNotAcceptableDiagnosis(jid, cycleId);
          }
          return false;
        }

        this.logger.warning(`WhatsApp ainda não aceitou mensagem ${messageNumber} (${message}). Retentando...`);
        if (this.isNotAcceptableError(message)) {
          delays = NOT_ACCEPTABLE_RETRY_DELAYS_MS;
          this.scheduleNotAcceptableDiagnosis(jid, cycleId);
        }
      }
    }

    return false;
  }

  private isRetryableSendError(errorMessage: string) {
    const normalizedMessage = errorMessage.toLowerCase();
    return (
      normalizedMessage.includes("not-acceptable") ||
      normalizedMessage.includes("timed out") ||
      normalizedMessage.includes("timeout") ||
      normalizedMessage.includes("temporarily")
    );
  }

  private isConnectionUnavailableError(errorMessage: string) {
    const normalizedMessage = errorMessage.toLowerCase();
    return (
      normalizedMessage.includes("connection closed") ||
      normalizedMessage.includes("connection is closed") ||
      normalizedMessage.includes("socket closed") ||
      normalizedMessage.includes("socket is closed") ||
      normalizedMessage.includes("websocket") ||
      normalizedMessage.includes("not connected") ||
      normalizedMessage.includes("não há conexão ativa")
    );
  }

  private isNotAcceptableError(errorMessage: string) {
    return errorMessage.toLowerCase().includes("not-acceptable");
  }

  private scheduleNotAcceptableDiagnosis(jid: string, cycleId: number) {
    if (this.diagnosedNotAcceptableCycles.has(cycleId)) return;
    setTimeout(() => {
      void this.diagnoseNotAcceptable(jid, cycleId);
    }, 2500);
  }

  private updateAdaptiveOpeningSettle(timeline?: RouteDispatchTimeline) {
    if (!timeline || this.monitoringMode !== "target") return;
    if (timeline.notAcceptableCount >= 2) {
      this.adaptiveOpeningSettleMs = Math.min(60, this.adaptiveOpeningSettleMs + 15);
      return;
    }
    if (timeline.notAcceptableCount === 0 && this.adaptiveOpeningSettleMs > 0) {
      this.adaptiveOpeningSettleMs = Math.max(0, this.adaptiveOpeningSettleMs - 15);
    }
  }

  private shouldUseSpeculativeSecondLane(trigger: RouteDispatch["trigger"]) {
    if (
      trigger !== "automatic" ||
      this.monitoringMode !== "target" ||
      this.getCurrentInternalWarmState() !== "ready"
    ) {
      return false;
    }

    // A conexão já está aquecida: não aguarde três corridas anteriores para
    // liberar a segunda rota. Ela sai logo depois da primeira chamada; qualquer
    // recusa continua coberta pelo retry, sem atrasar a rota que abriu a corrida.
    return true;
  }

  private maybeAlertNotAcceptable(count: number) {
    if (count < NOT_ACCEPTABLE_ALERT_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastNotAcceptableAlertAt < 1000 * 60 * 5) return;
    this.lastNotAcceptableAlertAt = now;
    this.logger.warning(
      `Alerta de velocidade: WhatsApp recusou envio ${count} vez(es) como not-acceptable neste disparo. O bot ativou retry/adaptação automática.`
    );
    this.addStatusEvent("error", `not-acceptable alto: ${count} tentativa(s) recusadas pelo WhatsApp.`);
  }

  private startHealthCheck() {
    this.clearHealthCheckTimer();
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private startWarmKeepAlive(reason: "armado" | "reconexão" = "armado") {
    this.clearWarmKeepAliveTimer();
    const config = this.configStore.load();

    const intervalMs = this.getWarmKeepAliveIntervalMs(config);
    this.warmKeepAliveIntervalMs = intervalMs;
    this.warmKeepAliveTimer = setInterval(() => {
      void this.runWarmKeepAlive("timer", config);
    }, intervalMs);

    const initialWarmup = this.runWarmKeepAlive(reason, config);
    void initialWarmup.catch(() => undefined);
    return initialWarmup;
  }

  private getDispatchRaceEventKey() {
    if (this.preparedTargetDispatchMode !== "ocr") return undefined;
    const analysisId = String(this.lastOcrInsight?.analysisId || "");
    const clientPrefix = `${this.clientEmail}:`;
    return analysisId.startsWith(clientPrefix) ? analysisId.slice(clientPrefix.length) : analysisId || undefined;
  }

  private scheduleClosingWarmup() {
    if (this.closingWarmupTimer) clearTimeout(this.closingWarmupTimer);
    this.closingWarmupTimer = setTimeout(() => {
      this.closingWarmupTimer = undefined;
      if (this.groupState !== "closed" || this.criticalDispatchInProgress || this.activeSendCycle) return;
      void this.runWarmKeepAlive("fechamento");
    }, 25);
    this.closingWarmupTimer.unref?.();
  }

  private async runWarmKeepAlive(
    reason: "timer" | "armado" | "reconexão" | "fechamento" = "timer",
    config = this.configStore.load()
  ) {
    if (this.status !== "connected" || !this.sock) return false;
    if (this.criticalDispatchInProgress || this.activeSendCycle) return false;
    if (reason === "timer" && Date.now() - this.lastOpeningSignalAt < 3_000) return false;
    if (reason === "timer" && (this.processingImageIds.size > 0 || this.ocrRouteSelection.status === "analyzing")) {
      return false;
    }
    const nextInterval = this.getWarmKeepAliveIntervalMs(config);
    if (this.warmKeepAliveIntervalMs && nextInterval !== this.warmKeepAliveIntervalMs) {
      void this.startWarmKeepAlive(reason === "reconexão" ? "reconexão" : "armado");
      return true;
    }

    const startedAt = Date.now();
    const forceFullWarm = reason !== "timer";
    if (forceFullWarm) {
      this.internalWarmState = "warming";
      this.emitSnapshot();
    }
    try {
      const activeGroup = this.getActiveMonitoringGroup(config);
      if (!activeGroup.jid) {
        this.internalWarmState = "cold";
        return false;
      }

      let metadata = this.groupMetadataCache.get(activeGroup.jid);
      const shouldRefreshFullMetadata =
        forceFullWarm ||
        !metadata ||
        Date.now() - this.lastFullMetadataWarmAt >= FULL_METADATA_KEEP_ALIVE_INTERVAL_MS;

      if (shouldRefreshFullMetadata) {
        metadata = await this.refreshGroupMetadata(activeGroup.jid);
        this.lastFullMetadataWarmAt = Date.now();
      }
      if (this.criticalDispatchInProgress || this.activeSendCycle) {
        this.internalWarmState = "cold";
        this.emitSnapshot();
        return false;
      }
      const shouldWarmActiveChat =
        forceFullWarm ||
        Date.now() - this.lastActiveChatWarmAt >= ACTIVE_CHAT_KEEP_ALIVE_INTERVAL_MS;
      const shouldWarmCrypto =
        forceFullWarm ||
        Date.now() - this.lastGroupCryptoWarmAt >= CRYPTO_SESSION_KEEP_ALIVE_INTERVAL_MS;
      const shouldWarmSenderKey =
        forceFullWarm ||
        Date.now() - this.lastSenderKeyWarmAt >= SENDER_KEY_KEEP_ALIVE_INTERVAL_MS;
      const shouldMeasureSocketRtt =
        forceFullWarm ||
        Date.now() - this.lastSocketRttAt >= SOCKET_RTT_KEEP_ALIVE_INTERVAL_MS;
      const cryptoSupported =
        typeof this.sock.getUSyncDevices === "function" &&
        typeof this.sock.assertSessions === "function";
      let cryptoReady =
        !cryptoSupported ||
        (
          this.lastGroupCryptoWarmAt > 0 &&
          Date.now() - this.lastGroupCryptoWarmAt < CRYPTO_SESSION_KEEP_ALIVE_INTERVAL_MS
        );
      let senderKeyReady =
        this.lastSenderKeyWarmAt > 0 &&
        Date.now() - this.lastSenderKeyWarmAt < SENDER_KEY_KEEP_ALIVE_INTERVAL_MS;
      const warmJobs: Promise<unknown>[] = [];
      if (shouldWarmActiveChat) {
        warmJobs.push(this.prewarmActiveChat(activeGroup.jid).then(() => {
          this.lastActiveChatWarmAt = Date.now();
        }));
      }
      if (shouldWarmCrypto && cryptoSupported) {
        warmJobs.push(this.prewarmGroupCrypto(metadata, forceFullWarm).then((ready) => {
          cryptoReady = ready;
        }));
      }
      if (shouldWarmSenderKey) {
        warmJobs.push(this.prewarmGroupSenderKeyMemory(activeGroup.jid).then((ready) => {
          senderKeyReady = ready;
        }));
      }
      if (shouldMeasureSocketRtt) void this.measureSocketRtt();
      if (!warmJobs.length) return this.getCurrentInternalWarmState() === "ready";
      await Promise.all(warmJobs);

      if (this.criticalDispatchInProgress || this.activeSendCycle || !cryptoReady || !senderKeyReady) {
        this.internalWarmState = "cold";
        this.emitSnapshot();
        return false;
      }
      this.prepareSendPlan();
      const finishedAt = Date.now();
      this.lastKeepAliveAt = new Date(finishedAt).toISOString();
      this.lastKeepAliveDurationMs = Date.now() - startedAt;
      this.lastInternalWarmAt = this.lastKeepAliveAt;
      this.lastInternalWarmDurationMs = this.lastKeepAliveDurationMs;
      this.internalWarmState = "ready";
      this.keepAliveCount += 1;
      if (forceFullWarm) {
        this.logger.info(
          `Preparação interna concluída em ${this.lastInternalWarmDurationMs}ms: ` +
          `${this.warmedGroupDeviceCount} dispositivo(s) prontos, sem enviar mensagem.`
        );
      }
      if (forceFullWarm) this.emitSnapshot();
      return true;
    } catch (error) {
      this.lastKeepAliveDurationMs = Date.now() - startedAt;
      this.lastInternalWarmDurationMs = this.lastKeepAliveDurationMs;
      this.internalWarmState = "cold";
      if (forceFullWarm) {
        this.logger.warning(`Preparação interna incompleta: ${this.getErrorMessage(error)}.`);
      }
      this.emitSnapshot();
      return false;
    }
  }

  private async waitForInitialInternalWarmup(warmup: Promise<boolean>) {
    return Promise.race([
      warmup,
      this.delay(INITIAL_INTERNAL_WARM_WAIT_MS).then(() => false)
    ]);
  }

  private getWarmKeepAliveIntervalMs(config = this.configStore.load()) {
    const configuredInterval = Math.max(15000, config.keepAliveIntervalMs || DEFAULT_KEEP_ALIVE_INTERVAL_MS);
    if (this.monitoringMode !== "target") return Math.max(60000, configuredInterval);
    return Math.min(configuredInterval, this.isCriticalWarmWindow() ? CRITICAL_KEEP_ALIVE_INTERVAL_MS : RACE_KEEP_ALIVE_INTERVAL_MS);
  }

  private invalidateInternalWarmState(clearCaches = false) {
    this.internalWarmState = "cold";
    if (!clearCaches) return;
    this.lastInternalWarmAt = undefined;
    this.lastInternalWarmDurationMs = 0;
    this.lastActiveChatWarmAt = 0;
    this.lastFullMetadataWarmAt = 0;
    this.warmedGroupParticipantSignature = "";
    this.lastGroupCryptoWarmAt = 0;
    this.lastGroupCryptoWarmDurationMs = 0;
    this.warmedGroupDeviceCount = 0;
    this.lastSenderKeyWarmAt = 0;
    this.lastSenderKeyWarmDurationMs = 0;
    this.lastSocketRttAt = 0;
    this.lastSocketRttMs = undefined;
  }

  private isCriticalWarmWindow(date = new Date()) {
    const parts = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Belem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
    const current = hour * 60 + minute;

    return CRITICAL_WINDOWS.some((window) => {
      const start = this.timeToMinutes(window.start);
      const end = this.timeToMinutes(window.end);
      return current >= start && current <= end;
    });
  }

  private timeToMinutes(value: string) {
    const [hour, minute] = value.split(":").map((item) => Number(item || 0));
    return hour * 60 + minute;
  }

  private async runHealthCheck() {
    if (!this.monitoringEnabled || this.status !== "connected" || !this.sock) return;
    if (this.criticalDispatchInProgress || this.activeSendCycle) return;

    try {
      this.performanceMetrics.eventLoopLagMs = await this.measureEventLoopLag();
      // O aquecimento dedicado já mantém o alvo pronto. Evite repetir leitura de
      // configuração, metadados e envelopes em outro timer durante a corrida.
      if (this.monitoringMode === "target") {
        if (this.sock?.ws && this.sock.ws.isOpen === false) {
          throw new Error("WebSocket do WhatsApp não está aberto.");
        }
      } else {
        await this.prewarmConnection();
      }
      this.consecutiveHealthCheckFailures = 0;
    } catch (error) {
      this.consecutiveHealthCheckFailures += 1;
      const detail = this.getErrorMessage(error);
      if (this.consecutiveHealthCheckFailures === 1 || this.consecutiveHealthCheckFailures % 3 === 0) {
        this.logger.warning(
          `Verificação de aquecimento falhou ${this.consecutiveHealthCheckFailures}x: ${detail}. ` +
          "Mantive a sessão ativa; a reconexão ocorrerá somente se o WhatsApp fechar o socket."
        );
      }
    }
  }

  private measureEventLoopLag() {
    const startedAt = Date.now();
    return new Promise<number>((resolve) => setImmediate(() => resolve(Math.max(0, Date.now() - startedAt))));
  }

  private async prewarmConnection(message?: string) {
    if (!this.sock || this.status !== "connected") return false;

    const config = this.configStore.load();
    const activeGroup = this.getActiveMonitoringGroup(config);
    if (!activeGroup.jid) return false;

    if (message) this.logger.info(message);

    this.syncMessagesFromConfig();
    const cachedMetadata = this.groupMetadataCache.get(activeGroup.jid);
    const shouldRefreshFullMetadata =
      !cachedMetadata ||
      Date.now() - this.lastFullMetadataWarmAt >= FULL_METADATA_KEEP_ALIVE_INTERVAL_MS;
    const metadata = shouldRefreshFullMetadata
      ? await this.refreshGroupMetadata(activeGroup.jid)
      : cachedMetadata;
    if (shouldRefreshFullMetadata) this.lastFullMetadataWarmAt = Date.now();
    if (metadata?.announce === true) {
      this.groupState = "closed";
    } else if (metadata?.announce === false) {
      this.groupState = "open";
    }
    const currentUserIds = this.getCurrentUserIds();
    const currentUserNumbers = currentUserIds.map((id) => id.split(":")[0].split("@")[0]).filter(Boolean);
    const participant = metadata?.participants?.find((item: any) => {
      const id = String(item.id || "");
      const number = id.split(":")[0].split("@")[0];
      return currentUserIds.includes(id) || currentUserNumbers.includes(number);
    });

    if (!participant) {
      this.currentUserInTargetGroup = false;
      this.logger.warning(`A conta conectada não apareceu na lista do ${activeGroup.label}. Verifique se ela ainda está no grupo.`);
      return false;
    }

    this.currentUserInTargetGroup = true;
    this.prepareSendPlan();
    if (shouldRefreshFullMetadata) {
      await Promise.all([
        this.prewarmActiveChat(activeGroup.jid),
        this.prewarmGroupCrypto(metadata)
      ]);
    }
    return true;
  }

  private async prewarmConnectionSafely(message?: string) {
    try {
      return await this.prewarmConnection(message);
    } catch (error) {
      const config = this.configStore.load();
      const activeGroup = this.getActiveMonitoringGroup(config);
      if (activeGroup.jid) this.groupMetadataCache.delete(activeGroup.jid);
      this.currentUserInTargetGroup = false;
      this.groupState = "unknown";
      this.logger.warning(
        `Pré-aquecimento ignorado sem derrubar o servidor: ${this.getErrorMessage(error)}. ` +
        "O WhatsApp será reconectado automaticamente se necessário."
      );
      this.emitSnapshot();
      return false;
    }
  }

  private async prewarmActiveChat(jid: string) {
    if (!this.sock || !jid) return;

    const jobs = [
      this.sock.presenceSubscribe?.(jid),
      this.sock.sendPresenceUpdate?.("available")
    ].filter(Boolean);

    if (!jobs.length) return;

    await Promise.race([
      Promise.allSettled(jobs),
      this.delay(2500)
    ]).catch(() => undefined);
  }

  private deferSecondarySocketTask(task: () => void) {
    if (this.criticalDispatchInProgress || (this.monitoringEnabled && this.monitoringMode === "target")) {
      const timer = setTimeout(task, this.criticalDispatchInProgress ? 1500 : 150);
      timer.unref?.();
      return;
    }
    setImmediate(task);
  }

  isCriticalDispatchActive() {
    return this.criticalDispatchInProgress;
  }

  private async prewarmGroupCrypto(metadata: any, force = false) {
    if (!this.sock || !metadata?.id || !Array.isArray(metadata.participants)) return false;
    if (typeof this.sock.getUSyncDevices !== "function" || typeof this.sock.assertSessions !== "function") return false;

    const participantJids = metadata.participants
      .map((participant: any) => String(participant?.id || ""))
      .filter(Boolean)
      .sort();
    if (!participantJids.length) return false;

    const signature = `${metadata.id}::${participantJids.join("|")}`;
    const isFresh = signature === this.warmedGroupParticipantSignature &&
      Date.now() - this.lastGroupCryptoWarmAt < CRYPTO_SESSION_KEEP_ALIVE_INTERVAL_MS;
    if (!force && isFresh) return true;
    if (this.groupCryptoWarmInFlight) return this.groupCryptoWarmInFlight;

    const startedAt = Date.now();
    const warmPromise = (async () => {
      try {
        // Ao armar/reconectar, consulte uma lista realmente fresca. Nos ciclos
        // periódicos, use o cache do Baileys para não criar tráfego desnecessário.
        const devices = await this.sock.getUSyncDevices(participantJids, !force, false);
        const deviceJids = (devices || [])
          .map((device: any) => String(device?.jid || ""))
          .filter(Boolean);
        if (deviceJids.length) await this.sock.assertSessions(deviceJids, false);
        this.warmedGroupParticipantSignature = signature;
        this.lastGroupCryptoWarmAt = Date.now();
        this.lastGroupCryptoWarmDurationMs = this.lastGroupCryptoWarmAt - startedAt;
        this.warmedGroupDeviceCount = deviceJids.length;
        if (force) {
          this.logger.info(`Criptografia do grupo pré-aquecida: ${participantJids.length} participante(s), ${deviceJids.length} dispositivo(s), ${this.lastGroupCryptoWarmDurationMs}ms.`);
        }
        return true;
      } catch (error) {
        this.lastGroupCryptoWarmDurationMs = Date.now() - startedAt;
        this.logger.warning(`Pré-aquecimento criptográfico não concluído: ${this.getErrorMessage(error)}.`);
        return false;
      }
    })();

    this.groupCryptoWarmInFlight = warmPromise;
    try {
      return await warmPromise;
    } finally {
      if (this.groupCryptoWarmInFlight === warmPromise) this.groupCryptoWarmInFlight = undefined;
    }
  }

  private async prewarmGroupSenderKeyMemory(jid: string) {
    const keys = this.sock?.authState?.keys;
    if (!jid || typeof keys?.get !== "function") {
      this.lastSenderKeyWarmAt = Date.now();
      this.lastSenderKeyWarmDurationMs = 0;
      return true;
    }

    const startedAt = Date.now();
    try {
      await keys.get("sender-key-memory", [jid]);
      this.lastSenderKeyWarmAt = Date.now();
      this.lastSenderKeyWarmDurationMs = this.lastSenderKeyWarmAt - startedAt;
      return true;
    } catch (error) {
      this.lastSenderKeyWarmDurationMs = Date.now() - startedAt;
      this.logger.warning(`Memória criptográfica do grupo não foi aquecida: ${this.getErrorMessage(error)}.`);
      return false;
    }
  }

  private async measureSocketRtt() {
    this.lastSocketRttAt = Date.now();
    if (!this.sock || typeof this.sock.query !== "function" || typeof this.sock.generateMessageTag !== "function") {
      return;
    }

    const startedAt = process.hrtime.bigint();
    try {
      const query = this.sock.query({
        tag: "iq",
        attrs: {
          id: this.sock.generateMessageTag(),
          to: "s.whatsapp.net",
          type: "get",
          xmlns: "w:p"
        },
        content: [{ tag: "ping", attrs: {} }]
      });
      await this.withTimeout(query, 1_500);
      this.lastSocketRttMs = roundMetric(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    } catch {
      this.lastSocketRttMs = undefined;
    }
  }

  private getReadinessChecks(): BotReadinessCheck[] {
    const config = this.configStore.load();
    const activeGroup = this.getActiveMonitoringGroup(config);

    return [
      {
        id: "whatsapp",
        label: "WhatsApp conectado",
        ok: this.status === "connected"
      },
      {
        id: "test_group",
        label: "Grupo de teste configurado",
        ok: Boolean(config.grupoTesteJid || config.grupoTesteNome)
      },
      {
        id: "group",
        label: this.monitoringMode === "test" ? "Grupo monitorado: teste" : "Grupo monitorado: alvo",
        ok: Boolean(activeGroup.jid)
      },
      {
        id: "participant",
        label: "Conta confirmada no grupo",
        ok: this.currentUserInTargetGroup
      },
      {
        id: "messages",
        label: this.monitoringMode === "test" ? "Mensagens de teste prontas" : config.targetDispatchMode === "ocr" ? "Nome de envio configurado" : "Mensagens do alvo prontas",
        ok: this.hasReadyMessages(this.monitoringMode)
      },
      {
        id: "group_state",
        label: "Estado do grupo validado",
        ok: this.groupState !== "unknown"
      },
      {
        id: "internal_warm",
        label: "Preparação interna aquecida",
        ok: this.getCurrentInternalWarmState() === "ready"
      },
      {
        id: "armed",
        label: "Bot armado para disparar",
        ok: this.monitoringEnabled
      }
    ];
  }

  private hasReadyMessages(mode: MonitoringMode = this.monitoringMode) {
    const config = this.configStore.load();
    const codes = mode === "test" ? config.codigosMensagensTeste : config.codigosMensagensAlvo;
    if (mode === "target" && config.targetDispatchMode === "ocr") return Boolean(config.nomeEnvio.trim());
    if ((codes || []).some((item) => item.trim())) return true;
    return false;
  }

  private getConfiguredOcrPreferences(config = this.configStore.load()): MonitoredRoute[] {
    const savedDetailed = config.rotasMonitoradasDetalhadas.filter((item) => item.bairro.trim());
    if (savedDetailed.length) return savedDetailed.filter((item) => item.enabled !== false).map((item) => ({ ...item, cidade: "" }));
    return config.rotasMonitoradas.map((query) => {
      const parts = query.split("/").map((part) => part.trim());
      return { cidade: "", bairro: parts.length === 2 ? parts[1] : query.trim() };
    }).filter((item) => item.bairro);
  }

  private describeConfiguredOcrRoutes(config = this.configStore.load()) {
    const detailed = (config.rotasMonitoradasDetalhadas || [])
      .filter((item) => item.bairro?.trim())
      .map((item) => item.regiao ? `${item.bairro} (${item.regiao})` : item.bairro);
    if (detailed.length) return detailed.join(" | ");
    return (config.rotasMonitoradas || []).join(" | ") || "nenhuma rota configurada";
  }

  private async waitUntilGroupAcceptsMessages(jid: string, cycleId: number) {
    const checks = [0, 60, 90, 120, 180, 240, 320, 420, 560];

    for (const wait of checks) {
      if (cycleId !== this.sendCycleId) return false;
      if (wait > 0) await this.delay(wait);

      try {
        const metadata = await this.refreshGroupMetadata(jid);
        if (metadata?.announce === false) return true;
      } catch {
        return true;
      }
    }

    this.logger.warning("O evento de abertura chegou, mas o servidor ainda pode estar atualizando o grupo.");
    return false;
  }

  private async diagnoseNotAcceptable(jid: string, cycleId: number) {
    if (this.diagnosedNotAcceptableCycles.has(cycleId)) return;
    this.diagnosedNotAcceptableCycles.add(cycleId);

    try {
      const metadata = await this.refreshGroupMetadata(jid);
      const currentUserIds = this.getCurrentUserIds();
      const currentUserNumbers = currentUserIds.map((id) => id.split(":")[0].split("@")[0]).filter(Boolean);
      const participant = metadata?.participants?.find((item: any) => {
        const id = String(item.id || "");
        const number = id.split(":")[0].split("@")[0];
        return currentUserIds.includes(id) || currentUserNumbers.includes(number);
      });

      const groupState = metadata?.announce === false ? "aberto para todos" : "fechado/somente admins";
      const participantState = participant
        ? `conta encontrada no grupo (${participant.admin || "membro"})`
        : "conta não encontrada na lista de participantes";

      this.logger.warning(
        `Diagnóstico not-acceptable: WhatsApp informa grupo ${groupState}; ${participantState}.`
      );

      if (metadata?.announce !== false) {
        this.logger.error(
          "O WhatsApp ainda está vendo o grupo como fechado no momento do disparo. Nesse estado o servidor recusa a mensagem."
        );
      }
    } catch (error) {
      this.logger.warning(`Não consegui diagnosticar o grupo após not-acceptable: ${this.getErrorMessage(error)}`);
    }
  }

  private isInvalidSession(statusCode?: number, errorMessage = "") {
    const normalizedMessage = errorMessage.toLowerCase();

    return [
      DisconnectReason?.loggedOut,
      DisconnectReason?.badSession,
      DisconnectReason?.multideviceMismatch
    ].filter((code): code is number => typeof code === "number").includes(statusCode as number) ||
      normalizedMessage.includes("logged out") ||
      normalizedMessage.includes("bad session") ||
      normalizedMessage.includes("multidevice mismatch") ||
      normalizedMessage.includes("invalid session") ||
      normalizedMessage.includes("session invalid") ||
      normalizedMessage.includes("invalid credentials");
  }

  private isRestartRequired(statusCode?: number, errorMessage = "") {
    const normalizedMessage = errorMessage.toLowerCase();
    return statusCode === DisconnectReason?.restartRequired || statusCode === 515 || normalizedMessage.includes("restart required");
  }

  private isConnectionConflict(statusCode?: number, errorMessage = "") {
    const normalizedMessage = errorMessage.toLowerCase();
    return statusCode === DisconnectReason?.connectionReplaced || (
      statusCode === 401 && (normalizedMessage.includes("conflict") || normalizedMessage.includes("connection replaced"))
    );
  }

  private disposeSocket(socket: any) {
    if (!socket) return;
    try {
      socket.ev?.removeAllListeners?.("creds.update");
      socket.ev?.removeAllListeners?.("connection.update");
      socket.ev?.removeAllListeners?.("groups.update");
      socket.ev?.removeAllListeners?.("group-participants.update");
      socket.ev?.removeAllListeners?.("messages.upsert");
      socket.ev?.removeAllListeners?.("messages.update");
      socket.ev?.removeAllListeners?.("messaging-history.set");
      socket.end?.(undefined);
      socket.ws?.close?.();
    } catch {
      // O socket já pode ter sido encerrado pelo próprio WhatsApp.
    }
  }

  private isQrRefAttemptLimit(statusCode?: number, errorMessage = "") {
    const normalizedMessage = errorMessage.toLowerCase();

    return (
      statusCode === DisconnectReason?.timedOut &&
      normalizedMessage.includes("qr") &&
      normalizedMessage.includes("attempt")
    ) || (
      statusCode === 408 &&
      normalizedMessage.includes("qr refs attempts ended")
    );
  }

  private hasAuthSession() {
    return (
      fs.existsSync(path.join(this.authDir, "auth.sqlite")) ||
      fs.existsSync(path.join(this.authDir, "creds.json"))
    );
  }

  private async logoutAndClearSession() {
    if (this.sock) {
      try {
        this.logger.info("Solicitando logout ao WhatsApp para remover este dispositivo conectado...");
        await this.sock.logout?.();
        this.logger.success("Logout solicitado ao WhatsApp.");
      } catch (error) {
        this.logger.warning(
          `Não foi possível confirmar logout no WhatsApp: ${this.getErrorMessage(error)}. Limpando sessão local mesmo assim.`
        );
      }
    }

    if (this.isRunning()) {
      await this.stop();
    } else {
      this.monitoringEnabled = false;
      this.clearReconnectTimer();
      this.clearHealthCheckTimer();
      this.clearWarmKeepAliveTimer();
    }

    this.clearQrCode();
    this.removeAuthDir();
    this.groupState = "unknown";
    this.currentUserInTargetGroup = false;
    this.preparedTargetJid = "";
    this.preparedMessages = [];
    this.preparedRelayMessages = [];
    this.preparedRelaySignature = "";
    this.preparedRelayBuiltAt = 0;
  }

  private isFatalRuntimeError(errorMessage = "") {
    const normalizedMessage = errorMessage.toLowerCase();
    return (
      normalizedMessage.includes("crypto is not defined") ||
      normalizedMessage.includes("referenceerror")
    );
  }

  private async getWhatsAppVersion() {
    try {
      await loadBaileys();
      const version = await lookupWhatsAppVersion();
      return version;
    } catch (error) {
      this.logger.warning(
        `Não foi possível consultar a versão mais recente do WhatsApp Web: ${this.getErrorMessage(error)}`
      );
      return undefined;
    }
  }

  private getDisconnectDescription(statusCode?: number, errorMessage = "") {
    const code = statusCode || "desconhecido";
    const message = errorMessage && errorMessage !== "undefined" ? ` Erro: ${errorMessage}` : "";
    return `Código: ${code}.${message}`;
  }

  private getCurrentUserIds() {
    return [
      this.sock?.user?.id,
      this.sock?.user?.lid,
      this.sock?.authState?.creds?.me?.id,
      this.sock?.authState?.creds?.me?.lid
    ]
      .map((id) => String(id || ""))
      .filter(Boolean);
  }

  private async refreshGroupMetadata(jid: string) {
    try {
      const metadata = await this.sock.groupMetadata(jid);
      if (metadata) {
        this.groupMetadataCache.set(jid, metadata);
      }

      return metadata;
    } catch (error) {
      const message = this.getErrorMessage(error);
      if (message.toLowerCase().includes("item-not-found")) {
        this.logger.warning("Grupo salvo não foi encontrado pelo WhatsApp. Atualize a lista e salve o grupo novamente.");
        return undefined;
      }

      throw error;
    }
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRunning() {
    return Boolean(this.sock) || ["connecting", "connected", "waiting_qr", "reconnecting"].includes(this.status);
  }

  private removeAuthDir() {
    try {
      this.destroyAuthState?.();
      this.destroyAuthState = undefined;
      this.closeAuthState = undefined;
      this.flushAuthState = undefined;
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
    } catch (error) {
      this.logger.error(`Erro ao apagar auth: ${this.getErrorMessage(error)}`);
    }
  }

  private clearPendingCredsSave() {
    if (this.pendingCredsSave) {
      clearTimeout(this.pendingCredsSave);
      this.pendingCredsSave = undefined;
    }
    this.credsSaveDirty = false;
    this.saveCredsNow = undefined;
  }

  private clearQrCode(resetAttempt = true) {
    this.qrCode = "";
    this.qrGeneratedAt = undefined;
    this.qrExpiresAt = undefined;
    if (resetAttempt) this.qrAttempt = 0;
  }

  private resetPartialQrAuth() {
    this.clearPendingCredsSave();
    this.removeAuthDir();
    this.reconnectAttempts = 0;
    this.unknownDisconnects = 0;
    this.qrReceivedInCurrentConnection = false;
    this.clearQrCode();
    this.setStatus("reconnecting");
  }

  private setStatus(status: BotStatus) {
    this.status = status;
    this.emitSnapshot();
  }

  private addStatusEvent(type: BotStatusEvent["type"], message: string) {
    const event: BotStatusEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      type,
      message
    };
    this.statusEvents = [event, ...this.statusEvents].slice(0, 300);
    this.saveStatusEvents();
    this.emitSnapshot();
  }

  private loadStatusEvents() {
    try {
      if (!fs.existsSync(this.statusEventsPath)) return [];
      const data = JSON.parse(fs.readFileSync(this.statusEventsPath, "utf-8"));
      return Array.isArray(data)
        ? data.map((item: any) => ({
            id: typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString(),
            type: ["connected", "disconnected", "reconnecting", "armed", "disarmed", "dispatch", "error"].includes(item.type) ? item.type : "error",
            message: typeof item.message === "string" ? item.message : ""
          })).filter((item: BotStatusEvent) => item.message).slice(0, 300)
        : [];
    } catch {
      return [];
    }
  }

  private saveStatusEvents() {
    try {
      fs.mkdirSync(path.dirname(this.statusEventsPath), { recursive: true });
      fs.writeFileSync(this.statusEventsPath, JSON.stringify(this.statusEvents, null, 2));
    } catch {
      // Status timeline is diagnostic; do not interrupt the bot.
    }
  }

  private emitSnapshot() {
    // No servidor web, o fanout é agrupado e obter o snapshot aqui repetiria
    // serialização pesada dezenas de vezes. No desktop, preserve o payload.
    this.emit("snapshot", this.deferSnapshotPayload ? undefined : this.getSnapshot());
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearHealthCheckTimer() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private clearWarmKeepAliveTimer() {
    if (this.warmKeepAliveTimer) {
      clearInterval(this.warmKeepAliveTimer);
      this.warmKeepAliveTimer = undefined;
    }
    if (this.closingWarmupTimer) {
      clearTimeout(this.closingWarmupTimer);
      this.closingWarmupTimer = undefined;
    }
    this.warmKeepAliveIntervalMs = 0;
  }

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private normalizePhoneFromUnknown(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string" || typeof value === "number") {
      return this.normalizePhone(String(value));
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const directValues = [
        record.user,
        record.phone,
        record.phoneNumber,
        record.phone_number,
        record.pn,
        record.id,
        record.jid,
        record._serialized
      ];

      for (const item of directValues) {
        const phone = this.normalizePhoneFromUnknown(item);
        if (phone) return phone;
      }

      for (const item of Object.values(record)) {
        const phone = this.normalizePhoneFromUnknown(item);
        if (phone) return phone;
      }
    }

    return "";
  }

  private normalizePhone(value: string) {
    return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  }
}

function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000;
}

function getOcrGaiolaCodeCandidates(code: string, allowAmbiguousCorrection = false) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return [];
  const candidates = [normalized];
  if (allowAmbiguousCorrection && /^H-1$/i.test(normalized)) candidates.push("I-1");
  return [...new Set(candidates)];
}

function isThumbsUpReaction(emoji: string) {
  return /^👍(?:🏻|🏼|🏽|🏾|🏿)?$/u.test(String(emoji || "").trim());
}
