import fs from "fs";
import { RouteClientIncident, RouteDispatch, RouteDispatchTimeline, RouteReaction, RouteReactionFinalState, RouteReactionHistoryEvent } from "../shared/types";
import { writeJsonAtomic } from "../storageJson";

const MAX_ROUTES = 50_000;
const INCIDENT_SNOOZE_DELAYS_MINUTES = [10, 5, 2];

export class RouteStore {
  private routes?: RouteDispatch[];
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  all(): RouteDispatch[] {
    return [...this.getRoutes()];
  }

  clear() {
    this.routes = [];
    this.scheduleSave(0);
  }

  create(input: Omit<RouteDispatch, "createdAt" | "updatedAt" | "validated" | "reactions">) {
    const now = new Date().toISOString();
    const route: RouteDispatch = {
      ...input,
      createdAt: now,
      updatedAt: now,
      validated: false,
      decisionStatus: "pending",
      reactions: [],
      reactionsHistory: [],
      lastReactionState: { status: "none" }
    };

    this.routes = [route, ...this.getRoutes()].slice(0, MAX_ROUTES);
    this.scheduleSave();
    return route;
  }

  update(id: string, patch: Partial<Pick<RouteDispatch, "confirmedCount" | "status" | "sentMessageIds" | "dispatchTimeline">>) {
    this.routes =
      this.getRoutes().map((route) =>
        route.id === id
          ? {
              ...route,
              ...patch,
              updatedAt: new Date().toISOString()
            }
          : route
      );
    this.scheduleSave();
  }

  validate(id: string, validatedBy: string, options: { source?: RouteDispatch["decisionSource"]; reason?: string; reactionAt?: string; leaderName?: string } = {}) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes =
      this.getRoutes().map((route) => {
        if (route.id !== id) return route;
        if ((route.decisionStatus || (route.validated ? "validated" : "pending")) === "validated") return route;
        changed = true;
        return {
          ...route,
          validated: true,
          decisionStatus: "validated",
          validatedAt: route.validatedAt || now,
          validatedBy,
          decisionSource: options.source || "admin_manual",
          decisionReason: options.reason?.trim() || undefined,
          validationReactionAt: options.reactionAt,
          validationLeaderName: options.leaderName,
          rejectedAt: undefined,
          rejectedBy: undefined,
          updatedAt: now
        };
      });
    if (changed) this.scheduleSave();
    return changed;
  }

  validateBySentMessageId(messageId: string, validatedBy: string, options: { source?: RouteDispatch["decisionSource"]; reason?: string; reactionAt?: string; leaderName?: string } = {}) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes =
      this.getRoutes().map((route) => {
        if (!route.sentMessageIds.includes(messageId)) return route;
        if ((route.decisionStatus || (route.validated ? "validated" : "pending")) === "validated") return route;
        changed = true;
        return {
          ...route,
          validated: true,
          decisionStatus: "validated",
          validatedAt: route.validatedAt || now,
          validatedBy,
          decisionSource: options.source || "admin_manual",
          decisionReason: options.reason?.trim() || undefined,
          validationReactionAt: options.reactionAt,
          validationLeaderName: options.leaderName,
          rejectedAt: undefined,
          rejectedBy: undefined,
          updatedAt: now
        };
      });
    if (changed) this.scheduleSave();
    return changed;
  }

  reject(id: string, rejectedBy: string, reason?: string) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes =
      this.getRoutes().map((route) => {
        if (route.id !== id) return route;
        changed = true;
        return {
          ...route,
          validated: false,
          decisionStatus: "rejected" as const,
          rejectedAt: route.rejectedAt || now,
          rejectedBy,
          decisionReason: reason?.trim() || route.decisionReason,
          decisionSource: "admin_manual" as const,
          validatedAt: undefined,
          validatedBy: undefined,
          validationReactionAt: undefined,
          validationLeaderName: undefined,
          updatedAt: now
        };
      });
    if (changed) this.scheduleSave();
    return changed;
  }

  requireClientIncident(messageId: string, incident: Omit<RouteClientIncident, "required" | "createdAt"> & { createdAt?: string }) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes = this.getRoutes().map((route) => {
      if (!route.sentMessageIds.includes(messageId)) return route;
      if (route.clientIncident?.required && !route.clientIncident.answeredAt) return route;
      changed = true;
      return {
        ...route,
        clientIncident: {
          ...incident,
          required: true,
          createdAt: incident.createdAt || now
        },
        updatedAt: incident.createdAt || now
      };
    });
    if (changed) this.scheduleSave();
    return changed;
  }

  answerClientIncident(routeId: string, answer: { valid: boolean; reason: string }) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes = this.getRoutes().map((route) => {
      if (route.id !== routeId || !route.clientIncident?.required || route.clientIncident.answeredAt) return route;
      changed = true;
      return {
        ...route,
        clientIncident: {
          ...route.clientIncident,
          valid: answer.valid,
          reason: answer.reason.trim(),
          answeredAt: now,
          required: false
        },
        updatedAt: now
      };
    });
    if (changed) this.scheduleSave();
    return changed;
  }

  snoozeClientIncident(routeId: string) {
    let result: { ok: boolean; delayMinutes?: number; nextDueAt?: string; exhausted?: boolean } = { ok: false };
    const now = new Date();
    const nowIso = now.toISOString();

    this.routes = this.getRoutes().map((route) => {
      if (route.id !== routeId || !route.clientIncident?.required || route.clientIncident.answeredAt) return route;

      const snoozeCount = Math.max(0, Number(route.clientIncident.snoozeCount || 0));
      const delayMinutes = INCIDENT_SNOOZE_DELAYS_MINUTES[snoozeCount];
      if (!delayMinutes) {
        result = { ok: false, exhausted: true };
        return route;
      }

      const nextDueAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
      result = { ok: true, delayMinutes, nextDueAt };
      return {
        ...route,
        clientIncident: {
          ...route.clientIncident,
          snoozeCount: snoozeCount + 1,
          snoozedUntil: nextDueAt,
          lastSnoozedAt: nowIso
        },
        updatedAt: nowIso
      };
    });

    if (result.ok) this.scheduleSave();
    return result;
  }

  static isClientIncidentDue(route: RouteDispatch, now = Date.now()) {
    const incident = route.clientIncident;
    if (!incident?.required || incident.answeredAt) return false;
    if (!incident.snoozedUntil) return true;
    const dueAt = new Date(incident.snoozedUntil).getTime();
    return !Number.isFinite(dueAt) || dueAt <= now;
  }

  recordDeletedMessage(messageId: string) {
    let changed = false;
    const now = new Date().toISOString();
    this.routes = this.getRoutes().map((route) => {
      if (!route.sentMessageIds.includes(messageId)) return route;
      changed = true;
      const deletedMessageIds = route.deletedMessageIds?.includes(messageId)
        ? route.deletedMessageIds
        : [messageId, ...(route.deletedMessageIds || [])];
      return {
        ...route,
        deletedMessageIds,
        updatedAt: now
      };
    });
    if (changed) this.scheduleSave();
    return changed;
  }

  addReaction(messageId: string, reaction: RouteReaction) {
    return this.recordReactionEvent(messageId, reaction, reaction.emoji ? "add" : "remove");
  }

  recordReactionEvent(messageId: string, reaction: RouteReaction, action: RouteReactionHistoryEvent["action"]) {
    let changed = false;
    const routes = this.getRoutes().map((route) => {
      if (!route.sentMessageIds.includes(messageId)) return route;

      changed = true;
      const alreadySaved = route.reactions.some((item) => item.id === reaction.id);
      const event: RouteReactionHistoryEvent = {
        ...reaction,
        id: `${reaction.id}:${action}`,
        action
      };
      const historyAlreadySaved = (route.reactionsHistory || []).some((item) => item.id === event.id);
      const lastReactionState: RouteReactionFinalState = {
        status: action === "remove" ? "removed" : "active",
        updatedAt: reaction.timestamp,
        emoji: reaction.emoji,
        senderPhone: reaction.senderPhone,
        leaderName: reaction.leaderName,
        isAdmin: reaction.isAdmin
      };

      return {
        ...route,
        reactions: action === "remove" || alreadySaved ? route.reactions : [reaction, ...route.reactions],
        reactionsHistory: historyAlreadySaved ? route.reactionsHistory : [event, ...(route.reactionsHistory || [])],
        lastReactionState,
        updatedAt: reaction.timestamp
      };
    });

    if (changed) {
      this.routes = routes;
      this.scheduleSave();
    }
    return changed;
  }

  flush() {
    this.saveNow(this.getRoutes());
  }

  private getRoutes() {
    if (!this.routes) this.routes = this.load();
    return this.routes;
  }

  private load(): RouteDispatch[] {
    for (const candidate of [this.filePath, `${this.filePath}.bak`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (Array.isArray(data)) return data.map((item) => this.normalize(item)).filter(Boolean).slice(0, MAX_ROUTES) as RouteDispatch[];
      } catch {
        // Um arquivo interrompido não pode apagar o histórico válido do backup.
      }
    }
    return [];
  }

  private saveNow(routes: RouteDispatch[]) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.hasValidRouteFile(this.filePath)) {
      writeJsonAtomic(`${this.filePath}.bak`, JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    }
    writeJsonAtomic(this.filePath, routes);
    this.dirty = false;
  }

  private hasValidRouteFile(filePath: string) {
    if (!fs.existsSync(filePath)) return false;
    try {
      return Array.isArray(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    } catch {
      return false;
    }
  }

  private scheduleSave(delayMs = 250) {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.dirty) return;
      try {
        this.saveNow(this.getRoutes());
      } catch {
        console.warn("Nao foi possivel persistir o historico de rotas; os registros continuam em memoria.");
      }
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private normalize(input: any): RouteDispatch | undefined {
    if (!input || typeof input.id !== "string") return undefined;

    return {
      id: input.id,
      clientEmail: typeof input.clientEmail === "string" ? input.clientEmail : "",
      groupJid: typeof input.groupJid === "string" ? input.groupJid : "",
      groupName: typeof input.groupName === "string" ? input.groupName : "",
      mode: input.mode === "test" ? "test" : "target",
      trigger: ["automatic", "manual", "warmup", "target-simulation", "simulation"].includes(input.trigger)
        ? input.trigger
        : input.mode === "test"
        ? "warmup"
        : "automatic",
      messages: Array.isArray(input.messages) ? input.messages.filter((item: unknown) => typeof item === "string") : [],
      sentMessageIds: Array.isArray(input.sentMessageIds)
        ? input.sentMessageIds.filter((item: unknown) => typeof item === "string")
        : [],
      confirmedCount: Number(input.confirmedCount || 0),
      totalCount: Number(input.totalCount || 0),
      status: ["sending", "sent", "partial", "failed"].includes(input.status) ? input.status : "sending",
      createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
      updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
      validated: Boolean(input.validated),
      decisionStatus: input.decisionStatus === "rejected" ? "rejected" : Boolean(input.validated) ? "validated" : "pending",
      validatedAt: typeof input.validatedAt === "string" ? input.validatedAt : undefined,
      validatedBy: typeof input.validatedBy === "string" ? input.validatedBy : undefined,
      rejectedAt: typeof input.rejectedAt === "string" ? input.rejectedAt : undefined,
      rejectedBy: typeof input.rejectedBy === "string" ? input.rejectedBy : undefined,
      decisionReason: typeof input.decisionReason === "string" ? input.decisionReason : undefined,
      decisionSource: input.decisionSource === "leader_reaction_1h" ? "leader_reaction_1h" : input.decisionSource === "admin_manual" ? "admin_manual" : undefined,
      validationReactionAt: typeof input.validationReactionAt === "string" ? input.validationReactionAt : undefined,
      validationLeaderName: typeof input.validationLeaderName === "string" ? input.validationLeaderName : undefined,
      reactions: Array.isArray(input.reactions)
        ? input.reactions.filter((item: unknown) => item && typeof item === "object").map((item: any) => ({
            id: typeof item.id === "string" ? item.id : "",
            timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString(),
            emoji: typeof item.emoji === "string" ? item.emoji : "",
            senderJid: typeof item.senderJid === "string" ? item.senderJid : "",
            senderPhone: typeof item.senderPhone === "string" ? item.senderPhone : "",
            senderIdentifiers: Array.isArray(item.senderIdentifiers)
              ? item.senderIdentifiers.filter((identifier: unknown) => typeof identifier === "string")
              : undefined,
            isAdmin: Boolean(item.isAdmin),
            leaderName: typeof item.leaderName === "string" ? item.leaderName : undefined
          })).filter((item: RouteReaction) => item.id)
        : [],
      reactionsHistory: Array.isArray(input.reactionsHistory)
        ? input.reactionsHistory.filter((item: unknown) => item && typeof item === "object").map((item: any) => ({
            id: typeof item.id === "string" ? item.id : "",
            timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString(),
            action: item.action === "remove" ? "remove" as const : "add" as const,
            emoji: typeof item.emoji === "string" ? item.emoji : "",
            senderJid: typeof item.senderJid === "string" ? item.senderJid : "",
            senderPhone: typeof item.senderPhone === "string" ? item.senderPhone : "",
            senderIdentifiers: Array.isArray(item.senderIdentifiers)
              ? item.senderIdentifiers.filter((identifier: unknown) => typeof identifier === "string")
              : undefined,
            isAdmin: Boolean(item.isAdmin),
            leaderName: typeof item.leaderName === "string" ? item.leaderName : undefined
          })).filter((item: RouteReactionHistoryEvent) => item.id)
        : [],
      lastReactionState: input.lastReactionState && typeof input.lastReactionState === "object"
        ? {
            status: input.lastReactionState.status === "removed" ? "removed" : input.lastReactionState.status === "active" ? "active" : "none",
            updatedAt: typeof input.lastReactionState.updatedAt === "string" ? input.lastReactionState.updatedAt : undefined,
            emoji: typeof input.lastReactionState.emoji === "string" ? input.lastReactionState.emoji : undefined,
            senderPhone: typeof input.lastReactionState.senderPhone === "string" ? input.lastReactionState.senderPhone : undefined,
            leaderName: typeof input.lastReactionState.leaderName === "string" ? input.lastReactionState.leaderName : undefined,
            isAdmin: typeof input.lastReactionState.isAdmin === "boolean" ? input.lastReactionState.isAdmin : undefined
          }
        : input.reactions?.length
        ? { status: "active" as const, updatedAt: input.updatedAt }
        : { status: "none" as const },
      ocr: input.ocr && typeof input.ocr === "object"
        ? {
            analysisId: typeof input.ocr.analysisId === "string" ? input.ocr.analysisId : undefined,
            source: typeof input.ocr.source === "string" ? input.ocr.source : "",
            text: typeof input.ocr.text === "string" ? input.ocr.text : undefined,
            line: typeof input.ocr.line === "string" ? input.ocr.line : undefined,
            route: typeof input.ocr.route === "string" ? input.ocr.route : undefined,
            cidade: typeof input.ocr.cidade === "string" ? input.ocr.cidade : undefined,
            bairro: typeof input.ocr.bairro === "string" ? input.ocr.bairro : undefined,
            regiao: typeof input.ocr.regiao === "string" ? input.ocr.regiao : undefined,
            code: typeof input.ocr.code === "string" ? input.ocr.code : undefined,
            paradas: Number.isFinite(Number(input.ocr.paradas)) ? Number(input.ocr.paradas) : undefined,
            pacotes: Number.isFinite(Number(input.ocr.pacotes)) ? Number(input.ocr.pacotes) : undefined,
            confidence: Number.isFinite(Number(input.ocr.confidence)) ? Number(input.ocr.confidence) : undefined,
            processedAt: typeof input.ocr.processedAt === "string" ? input.ocr.processedAt : new Date().toISOString(),
            imagePreviewUrl: typeof input.ocr.imagePreviewUrl === "string" ? input.ocr.imagePreviewUrl : undefined,
            analysisOptions: Array.isArray(input.ocr.analysisOptions) ? input.ocr.analysisOptions : undefined,
            analysisTiming: input.ocr.analysisTiming && typeof input.ocr.analysisTiming === "object" ? input.ocr.analysisTiming : undefined,
            analysisMessage: typeof input.ocr.analysisMessage === "string" ? input.ocr.analysisMessage : undefined,
            preparedMessages: Array.isArray(input.ocr.preparedMessages) ? input.ocr.preparedMessages.filter((item: unknown) => typeof item === "string") : undefined
          }
        : undefined,
      clientIncident: input.clientIncident && typeof input.clientIncident === "object"
        ? {
            // Deleted messages stay auditable, but they no longer block the client.
            required: input.clientIncident.kind === "message_deleted" ? false : Boolean(input.clientIncident.required),
            kind: input.clientIncident.kind === "message_deleted" ? "message_deleted" : "leader_reaction_removed",
            createdAt: typeof input.clientIncident.createdAt === "string" ? input.clientIncident.createdAt : new Date().toISOString(),
            message: typeof input.clientIncident.message === "string" ? input.clientIncident.message : "",
            snoozedUntil: typeof input.clientIncident.snoozedUntil === "string" ? input.clientIncident.snoozedUntil : undefined,
            snoozeCount: Number.isFinite(Number(input.clientIncident.snoozeCount)) ? Math.max(0, Number(input.clientIncident.snoozeCount)) : 0,
            lastSnoozedAt: typeof input.clientIncident.lastSnoozedAt === "string" ? input.clientIncident.lastSnoozedAt : undefined,
            answeredAt: typeof input.clientIncident.answeredAt === "string" ? input.clientIncident.answeredAt : undefined,
            valid: typeof input.clientIncident.valid === "boolean" ? input.clientIncident.valid : undefined,
            reason: typeof input.clientIncident.reason === "string" ? input.clientIncident.reason : undefined
          }
        : undefined,
      deletedMessageIds: Array.isArray(input.deletedMessageIds)
        ? input.deletedMessageIds.filter((item: unknown) => typeof item === "string")
        : [],
      dispatchTimeline: this.normalizeTimeline(input.dispatchTimeline)
    };
  }

  private normalizeTimeline(input: any): RouteDispatchTimeline | undefined {
    if (!input || typeof input !== "object") return undefined;
    const events = Array.isArray(input.events)
      ? input.events.filter((event: unknown) => event && typeof event === "object").map((event: any) => ({
          id: typeof event.id === "string" ? event.id : `${Date.now()}-${Math.random()}`,
          label: typeof event.label === "string" ? event.label : "",
          at: typeof event.at === "string" ? event.at : new Date().toISOString(),
          offsetMs: Number.isFinite(Number(event.offsetMs)) ? Number(event.offsetMs) : 0,
          level: ["info", "success", "warning", "error"].includes(event.level) ? event.level : "info",
          detail: typeof event.detail === "string" ? event.detail : undefined
        })).filter((event) => event.label)
      : [];

    return {
      eventDetectedAt: typeof input.eventDetectedAt === "string" ? input.eventDetectedAt : new Date().toISOString(),
      sendStartedAt: typeof input.sendStartedAt === "string" ? input.sendStartedAt : new Date().toISOString(),
      firstRelayCalledAt: typeof input.firstRelayCalledAt === "string" ? input.firstRelayCalledAt : undefined,
      firstAckAt: typeof input.firstAckAt === "string" ? input.firstAckAt : undefined,
      firstGroupEchoAt: typeof input.firstGroupEchoAt === "string" ? input.firstGroupEchoAt : undefined,
      finishedAt: typeof input.finishedAt === "string" ? input.finishedAt : undefined,
      detectionDelayMs: Number.isFinite(Number(input.detectionDelayMs)) ? Number(input.detectionDelayMs) : 0,
      firstRelayCallMs: Number.isFinite(Number(input.firstRelayCallMs)) ? Number(input.firstRelayCallMs) : undefined,
      firstAckMs: Number.isFinite(Number(input.firstAckMs)) ? Number(input.firstAckMs) : undefined,
      firstGroupEchoMs: Number.isFinite(Number(input.firstGroupEchoMs)) ? Number(input.firstGroupEchoMs) : undefined,
      ackWaitMs: Number.isFinite(Number(input.ackWaitMs)) ? Number(input.ackWaitMs) : undefined,
      totalDurationMs: Number.isFinite(Number(input.totalDurationMs)) ? Number(input.totalDurationMs) : undefined,
      timeoutUsed: Boolean(input.timeoutUsed),
      retryUsed: Boolean(input.retryUsed),
      notAcceptableCount: Number.isFinite(Number(input.notAcceptableCount)) ? Number(input.notAcceptableCount) : 0,
      mode: input.mode === "race" ? "race" : "normal",
      openingSignal: ["group_update", "opening_message", "already_open", "image_ready", "manual", "simulation"].includes(input.openingSignal) ? input.openingSignal : undefined,
      internalWarmState: ["cold", "warming", "ready"].includes(input.internalWarmState) ? input.internalWarmState : undefined,
      internalWarmAgeMs: Number.isFinite(Number(input.internalWarmAgeMs)) ? Number(input.internalWarmAgeMs) : undefined,
      authBackend: input.authBackend === "sqlite" ? "sqlite" : input.authBackend === "multi-file" ? "multi-file" : undefined,
      warmedDeviceCount: Number.isFinite(Number(input.warmedDeviceCount)) ? Number(input.warmedDeviceCount) : undefined,
      socketRttMs: Number.isFinite(Number(input.socketRttMs)) ? Number(input.socketRttMs) : undefined,
      signalKeyReadMs: Number.isFinite(Number(input.signalKeyReadMs)) ? Number(input.signalKeyReadMs) : undefined,
      signalKeyWriteMs: Number.isFinite(Number(input.signalKeyWriteMs)) ? Number(input.signalKeyWriteMs) : undefined,
      signalKeyReadOps: Number.isFinite(Number(input.signalKeyReadOps)) ? Number(input.signalKeyReadOps) : undefined,
      signalKeyWriteOps: Number.isFinite(Number(input.signalKeyWriteOps)) ? Number(input.signalKeyWriteOps) : undefined,
      secondLaneMode: input.secondLaneMode === "speculative" ? "speculative" : input.secondLaneMode === "ack-gated" ? "ack-gated" : undefined,
      events
    };
  }
}
