import fs from "fs";
import { RouteDispatchTimeline } from "../shared/types";
import { writeJsonAtomic } from "../storageJson";

export type DispatchTelemetryEvent = {
  id: string;
  timestamp: string;
  clientEmail: string;
  trigger?: string;
  mode: "target" | "test";
  confirmed: number;
  total: number;
  firstRelayMs?: number;
  firstAckMs?: number;
  firstGroupEchoMs?: number;
  totalDurationMs?: number;
  internalWarmState?: "cold" | "warming" | "ready";
  timeoutUsed: boolean;
  retryUsed: boolean;
  notAcceptableCount: number;
};

export type DispatchTelemetrySummary = {
  count: number;
  averageFirstRelayMs: number;
  p95FirstRelayMs: number;
  averageFirstAckMs: number;
  p95FirstAckMs: number;
  averageFirstGroupEchoMs: number;
  p95FirstGroupEchoMs: number;
  averageTotalDurationMs: number;
  p95TotalDurationMs: number;
  successRate: number;
  warmDispatchCount: number;
  coldDispatchCount: number;
  timeoutCount: number;
  retryCount: number;
  notAcceptableCount: number;
  lastNotAcceptableAt?: string;
};

const MAX_EVENTS = 1000;

export class TelemetryStore {
  private events?: DispatchTelemetryEvent[];
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private automaticWriteDeadline = 0;

  constructor(private readonly filePath: string, private readonly deferAutomaticWrite: () => boolean = () => false) {}

  all() {
    return [...this.getEvents()];
  }

  record(input: {
    clientEmail: string;
    trigger?: string;
    mode: "target" | "test";
    confirmed: number;
    total: number;
    timeline?: RouteDispatchTimeline;
  }) {
    const now = new Date().toISOString();
    const event: DispatchTelemetryEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: now,
      clientEmail: input.clientEmail,
      trigger: input.trigger,
      mode: input.mode,
      confirmed: input.confirmed,
      total: input.total,
      firstRelayMs: input.timeline?.firstRelayCallMs,
      firstAckMs: input.timeline?.firstAckMs,
      firstGroupEchoMs: input.timeline?.firstGroupEchoMs,
      totalDurationMs: input.timeline?.totalDurationMs,
      internalWarmState: input.timeline?.internalWarmState,
      timeoutUsed: Boolean(input.timeline?.timeoutUsed),
      retryUsed: Boolean(input.timeline?.retryUsed),
      notAcceptableCount: input.timeline?.notAcceptableCount || 0
    };

    this.events = [event, ...this.getEvents()].slice(0, MAX_EVENTS);
    this.scheduleSave();
    return event;
  }

  summary(windowMs = 1000 * 60 * 60 * 24 * 7): DispatchTelemetrySummary {
    const cutoff = Date.now() - windowMs;
    const events = this.getEvents().filter((event) => new Date(event.timestamp).getTime() >= cutoff);
    const firstRelay = events.map((event) => event.firstRelayMs).filter((value): value is number => Number.isFinite(value));
    const firstAck = events.map((event) => event.firstAckMs).filter((value): value is number => Number.isFinite(value));
    const firstGroupEcho = events.map((event) => event.firstGroupEchoMs).filter((value): value is number => Number.isFinite(value));
    const totalDuration = events.map((event) => event.totalDurationMs).filter((value): value is number => Number.isFinite(value));
    const notAcceptableEvents = events.filter((event) => event.notAcceptableCount > 0);

    return {
      count: events.length,
      averageFirstRelayMs: average(firstRelay),
      p95FirstRelayMs: percentile(firstRelay, 95),
      averageFirstAckMs: average(firstAck),
      p95FirstAckMs: percentile(firstAck, 95),
      averageFirstGroupEchoMs: average(firstGroupEcho),
      p95FirstGroupEchoMs: percentile(firstGroupEcho, 95),
      averageTotalDurationMs: average(totalDuration),
      p95TotalDurationMs: percentile(totalDuration, 95),
      successRate: rate(events.reduce((total, event) => total + event.confirmed, 0), events.reduce((total, event) => total + event.total, 0)),
      warmDispatchCount: events.filter((event) => event.internalWarmState === "ready").length,
      coldDispatchCount: events.filter((event) => event.internalWarmState === "cold" || event.internalWarmState === "warming").length,
      timeoutCount: events.filter((event) => event.timeoutUsed).length,
      retryCount: events.filter((event) => event.retryUsed).length,
      notAcceptableCount: events.reduce((total, event) => total + event.notAcceptableCount, 0),
      lastNotAcceptableAt: notAcceptableEvents[0]?.timestamp
    };
  }

  flush() {
    this.saveNow(this.getEvents());
  }

  private getEvents() {
    if (!this.events) this.events = this.load();
    return this.events;
  }

  private load(): DispatchTelemetryEvent[] {
    if (!fs.existsSync(this.filePath)) return [];

    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return Array.isArray(data)
        ? data.map((item) => this.normalize(item)).filter(Boolean) as DispatchTelemetryEvent[]
        : [];
    } catch {
      return [];
    }
  }

  private normalize(input: any): DispatchTelemetryEvent | undefined {
    if (!input || typeof input.id !== "string" || typeof input.timestamp !== "string") return undefined;
    return {
      id: input.id,
      timestamp: input.timestamp,
      clientEmail: typeof input.clientEmail === "string" ? input.clientEmail : "",
      trigger: typeof input.trigger === "string" ? input.trigger : undefined,
      mode: input.mode === "test" ? "test" : "target",
      confirmed: Number(input.confirmed || 0),
      total: Number(input.total || 0),
      firstRelayMs: Number.isFinite(Number(input.firstRelayMs)) ? Number(input.firstRelayMs) : undefined,
      firstAckMs: Number.isFinite(Number(input.firstAckMs)) ? Number(input.firstAckMs) : undefined,
      firstGroupEchoMs: Number.isFinite(Number(input.firstGroupEchoMs)) ? Number(input.firstGroupEchoMs) : undefined,
      totalDurationMs: Number.isFinite(Number(input.totalDurationMs)) ? Number(input.totalDurationMs) : undefined,
      internalWarmState: input.internalWarmState === "ready" || input.internalWarmState === "warming" || input.internalWarmState === "cold"
        ? input.internalWarmState
        : undefined,
      timeoutUsed: Boolean(input.timeoutUsed),
      retryUsed: Boolean(input.retryUsed),
      notAcceptableCount: Number(input.notAcceptableCount || 0)
    };
  }

  private saveNow(events: DispatchTelemetryEvent[]) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    writeJsonAtomic(this.filePath, events);
    this.dirty = false;
    this.automaticWriteDeadline = 0;
  }

  private scheduleSave(delayMs = 250) {
    if (!this.dirty) this.automaticWriteDeadline = Date.now() + 2000;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.dirty) return;
      if (this.deferAutomaticWrite() && Date.now() < this.automaticWriteDeadline) {
        this.scheduleSave(25);
        return;
      }
      try {
        this.saveNow(this.getEvents());
      } catch {
        console.warn("Nao foi possivel persistir a telemetria; os eventos continuam em memoria.");
      }
    }, delayMs);
    this.flushTimer.unref?.();
  }
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile(values: number[], pct: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Math.round(sorted[index] || 0);
}

function rate(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}
