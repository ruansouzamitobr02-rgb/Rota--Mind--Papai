import { writeJsonAtomic } from "./storageJson";
import fs from "fs";
import { AdminImageUsageSnapshot, ClientImageUsageSnapshot, ImageAnalysisResult, ImageUsageDecision, ImageUsageEntry, RouteDispatch } from "./shared/types";
import { isRouteDeleted, routeDeletedAt } from "./shared/routeLifecycle";
type StoredImageUsage = {
  entries: ImageUsageEntry[];
  defaultAmounts: Record<string, number>;
  monthlyTotalOverrides: Record<string, number>;
  billAllValidatedRoutes: Record<string, boolean>;
  routePrices: Record<string, number>;
  prepaidRoutes: Record<string, number>;
  dueDays: Record<string, number>;
  paymentEveryRoutes: Record<string, number>;
  lastPayments: Record<string, string>;
  deletedRoutes: Record<string, string>;
  creditBalances: Record<string, number>;
};

type RecordAnalysisInput = {
  id: string;
  clientEmail: string;
  messageId: string;
  result: ImageAnalysisResult;
  route?: string;
  bairro?: string;
  gaiola?: string;
  confidence?: number;
  groupJid?: string;
  groupName?: string;
  analysisStartedAt?: string;
  analysisFinishedAt?: string;
  analysisDurationMs?: number;
};

type ValidatedRouteUsageInput = Omit<RecordAnalysisInput, "id"> & {
  analysisId?: string;
  routeDispatchId: string;
  billingSource?: "target" | "manual" | "ai" | "image";
};

const MAX_ENTRIES = 50_000;

export class ImageUsageStore {
  private data: StoredImageUsage;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  record(input: RecordAnalysisInput) {
    const normalizedEmail = input.clientEmail.trim().toLowerCase();
    const existing = this.data.entries.find((entry) => entry.id === input.id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const entry: ImageUsageEntry = {
      ...input,
      clientEmail: normalizedEmail,
      decision: "pending",
      amountCents: this.defaultAmount(normalizedEmail),
      createdAt: now,
      updatedAt: now
    };
    this.data.entries = [entry, ...this.data.entries].slice(0, MAX_ENTRIES);
    this.save();
    return entry;
  }

  get(id: string) {
    return this.data.entries.find((entry) => entry.id === id);
  }

  decide(id: string, decision: ImageUsageDecision, adminEmail: string, amountCents?: number, note?: string) {
    let changed = false;
    const now = new Date().toISOString();
    this.data.entries = this.data.entries.map((entry) => {
      if (entry.id !== id) return entry;
      if (entry.cancellation || (entry.routeDispatchId && this.isDeletedRoute(entry.clientEmail, entry.routeDispatchId))) return entry;
      changed = true;
      return {
        ...entry,
        decision,
        amountCents: amountCents === undefined ? entry.amountCents : this.normalizeAmount(amountCents),
        note: note?.trim() || undefined,
        reviewedAt: now,
        reviewedBy: adminEmail,
        updatedAt: now
      };
    });
    if (changed) this.save();
    return changed;
  }

  decideForRoute(analysisId: string | undefined, routeDispatchId: string, decision: Exclude<ImageUsageDecision, "pending">, adminEmail: string, clientEmail?: string) {
    let changed = false;
    const now = new Date().toISOString();
    this.data.entries = this.data.entries.map((entry) => {
      if (clientEmail && entry.clientEmail !== clientEmail.trim().toLowerCase()) return entry;
      if (entry.routeDispatchId !== routeDispatchId && (!analysisId || entry.id !== analysisId || entry.routeDispatchId)) return entry;
      if (entry.cancellation || this.isDeletedRoute(entry.clientEmail, routeDispatchId)) return entry;
      if (entry.decision === decision && entry.routeDispatchId === routeDispatchId) return entry;
      changed = true;
      return {
        ...entry,
        routeDispatchId,
        decision,
        amountCents: decision === "billable" && entry.amountCents <= 0 ? this.defaultAmount(entry.clientEmail) : entry.amountCents,
        reviewedAt: now,
        reviewedBy: adminEmail,
        updatedAt: now
      };
    });
    if (changed) this.save();
    return changed;
  }

  decideValidatedRoute(input: ValidatedRouteUsageInput, reviewedBy: string) {
    const normalizedEmail = input.clientEmail.trim().toLowerCase();
    if (this.isDeletedRoute(normalizedEmail, input.routeDispatchId)) return false;
    const routeEntry = this.data.entries.find((entry) => entry.clientEmail === normalizedEmail && entry.routeDispatchId === input.routeDispatchId);
    if (routeEntry?.cancellation) return false;
    if (routeEntry?.decision === "billable") return false;
    const analysisEntry = input.analysisId ? this.data.entries.find((entry) => entry.id === input.analysisId && entry.clientEmail === normalizedEmail) : undefined;
    const reusableAnalysis = analysisEntry && !analysisEntry.cancellation && (!analysisEntry.routeDispatchId || analysisEntry.routeDispatchId === input.routeDispatchId)
      ? analysisEntry
      : undefined;
    const legacy = routeEntry || reusableAnalysis || (!input.analysisId ? this.findLegacyAnalysisForRoute(input, normalizedEmail) : undefined);
    const entry = legacy || this.record({
      ...input,
      id: `validated-route:${normalizedEmail}:${input.routeDispatchId}`,
      clientEmail: normalizedEmail
    });
    const now = new Date().toISOString();
    const prepaid = this.data.prepaidRoutes[normalizedEmail] || 0;
    const prepaidCovered = prepaid > 0;
    if (prepaidCovered) this.data.prepaidRoutes[normalizedEmail] = prepaid - 1;
    const price = this.routePrice(normalizedEmail);
    const creditAppliedCents = prepaidCovered ? 0 : Math.min(price, this.data.creditBalances[normalizedEmail] || 0);
    if (creditAppliedCents) this.data.creditBalances[normalizedEmail] -= creditAppliedCents;
    this.data.entries = this.data.entries.map((candidate) => candidate.id !== entry.id ? candidate : {
      ...candidate,
      routeDispatchId: input.routeDispatchId,
      route: input.route || candidate.route,
      bairro: input.bairro || candidate.bairro,
      gaiola: input.gaiola || candidate.gaiola,
      groupJid: input.groupJid || candidate.groupJid,
      groupName: input.groupName || candidate.groupName,
      billingSource: input.billingSource || candidate.billingSource || "image",
      decision: "billable",
      amountCents: prepaidCovered ? 0 : price - creditAppliedCents,
      creditAppliedCents,
      paymentStatus: prepaidCovered ? "prepaid" : creditAppliedCents >= price && price > 0 ? "paid" : "unpaid",
      paidAt: !prepaidCovered && creditAppliedCents >= price && price > 0 ? now : undefined,
      reviewedAt: now,
      reviewedBy,
      updatedAt: now
    });
    this.save();
    return true;
  }

  isDeletedRoute(clientEmail: string, routeId: string) {
    return Boolean(this.data.deletedRoutes[`${clientEmail.trim().toLowerCase()}:${routeId}`]);
  }

  cancelDeletedRoutes(routes: RouteDispatch[], clientEmail: string) {
    const email = clientEmail.trim().toLowerCase();
    const deleted = new Map(routes.filter(isRouteDeleted).map((route) => [route.id, route]));
    if (!deleted.size) return false;
    const liveAnalysisIds = new Set(routes.filter((route) => !isRouteDeleted(route)).map((route) => route.ocr?.analysisId).filter(Boolean));
    const deletedByAnalysis = new Map([...deleted.values()].filter((route) => route.ocr?.analysisId && !liveAnalysisIds.has(route.ocr.analysisId)).map((route) => [route.ocr!.analysisId!, route]));
    const needsRegistration = [...deleted.keys()].some((id) => !this.isDeletedRoute(email, id));
    const needsCancellation = this.data.entries.some((entry) => entry.clientEmail === email && !entry.cancellation
      && (entry.routeDispatchId ? deleted.has(entry.routeDispatchId) : deletedByAnalysis.has(entry.id)));
    if (!needsRegistration && !needsCancellation) return false;
    const originalData = this.data;
    this.data = { ...this.data, deletedRoutes: { ...this.data.deletedRoutes }, prepaidRoutes: { ...this.data.prepaidRoutes }, creditBalances: { ...this.data.creditBalances } };
    let changed = false;
    for (const route of deleted.values()) {
      const key = `${email}:${route.id}`;
      if (!this.data.deletedRoutes[key]) {
        this.data.deletedRoutes[key] = routeDeletedAt(route);
        changed = true;
      }
    }
    this.data.entries = this.data.entries.map((entry) => {
      if (entry.clientEmail !== email || entry.cancellation) return entry;
      const route = entry.routeDispatchId ? deleted.get(entry.routeDispatchId) : undefined;
      // Analysis IDs can belong to several dispatched routes. Never cancel a
      // sibling route simply because it used the same source image.
      const unlinkedRoute = !entry.routeDispatchId ? deletedByAnalysis.get(entry.id) : undefined;
      const cancelledRoute = route || unlinkedRoute;
      if (!cancelledRoute) return entry;
      changed = true;
      const wasBillable = entry.decision === "billable" || Boolean(entry.paymentStatus);
      const prepaidRestored = wasBillable && entry.paymentStatus === "prepaid";
      const creditGrantedCents = wasBillable && !prepaidRestored
        ? (entry.creditAppliedCents || 0) + (entry.paymentStatus === "paid" ? entry.amountCents : 0) : 0;
      if (prepaidRestored) this.data.prepaidRoutes[email] = (this.data.prepaidRoutes[email] || 0) + 1;
      if (creditGrantedCents) this.data.creditBalances[email] = (this.data.creditBalances[email] || 0) + creditGrantedCents;
      return {
        ...entry, routeDispatchId: cancelledRoute.id, decision: "excluded" as const,
        cancellation: {
          reason: "message_deleted" as const, cancelledAt: routeDeletedAt(cancelledRoute),
          previousDecision: entry.decision, previousPaymentStatus: entry.paymentStatus,
          originalAmountCents: entry.amountCents, prepaidRestored, creditGrantedCents
        },
        note: [entry.note, "Mensagem apagada: validação e consumo cancelados."].filter(Boolean).join("\n"),
        updatedAt: new Date().toISOString()
      };
    });
    if (changed) {
      try { this.save(); } catch (error) { this.data = originalData; throw error; }
    }
    return changed;
  }

  renameClientEmail(previous: string, next: string) {
    this.data.entries = this.data.entries.map((entry) => entry.clientEmail === previous ? { ...entry, clientEmail: next } : entry);
    if (Object.prototype.hasOwnProperty.call(this.data.defaultAmounts, previous)) {
      this.data.defaultAmounts[next] = this.data.defaultAmounts[previous];
      delete this.data.defaultAmounts[previous];
    }
    for (const key of Object.keys(this.data.monthlyTotalOverrides)) {
      if (!key.endsWith(`:${previous}`)) continue;
      this.data.monthlyTotalOverrides[key.slice(0, -previous.length) + next] = this.data.monthlyTotalOverrides[key];
      delete this.data.monthlyTotalOverrides[key];
    }
    if (Object.prototype.hasOwnProperty.call(this.data.billAllValidatedRoutes, previous)) {
      this.data.billAllValidatedRoutes[next] = this.data.billAllValidatedRoutes[previous];
      delete this.data.billAllValidatedRoutes[previous];
    }
    for (const key of Object.keys(this.data.deletedRoutes)) {
      if (key.startsWith(`${previous}:`)) {
        this.data.deletedRoutes[`${next}:${key.slice(previous.length + 1)}`] = this.data.deletedRoutes[key];
        delete this.data.deletedRoutes[key];
      }
    }
    for (const map of [this.data.routePrices, this.data.prepaidRoutes, this.data.creditBalances, this.data.dueDays, this.data.paymentEveryRoutes, this.data.lastPayments]) {
      if (Object.prototype.hasOwnProperty.call(map, previous)) {
        map[next] = map[previous];
        delete map[previous];
      }
    }
    this.save();
  }

  setBillAllValidatedRoutes(clientEmail: string, enabled: boolean) {
    this.data.billAllValidatedRoutes[clientEmail.trim().toLowerCase()] = Boolean(enabled);
    this.save();
  }

  billsAllValidatedRoutes(clientEmail: string) {
    void clientEmail;
    return true;
  }

  setDefaultAmount(clientEmail: string, amountCents: number) {
    const email = clientEmail.trim().toLowerCase();
    this.data.defaultAmounts[email] = this.normalizeAmount(amountCents);
    this.data.routePrices[email] = this.normalizeAmount(amountCents);
    this.save();
  }

  setRoutePrice(clientEmail: string, amountCents: number) {
    const email = clientEmail.trim().toLowerCase();
    this.data.routePrices[email] = this.normalizeAmount(amountCents);
    this.data.defaultAmounts[email] = this.data.routePrices[email];
    this.save();
  }

  addPrepaidRoutes(clientEmail: string, quantity: number) {
    const email = clientEmail.trim().toLowerCase();
    this.data.prepaidRoutes[email] = Math.max(0, (this.data.prepaidRoutes[email] || 0) + Math.floor(quantity));
    this.save();
  }

  setPrepaidRoutes(clientEmail: string, quantity: number) {
    const email = clientEmail.trim().toLowerCase();
    this.data.prepaidRoutes[email] = Math.max(0, Math.floor(quantity));
    this.save();
  }

  setDueDay(clientEmail: string, day: number) {
    this.data.dueDays[clientEmail.trim().toLowerCase()] = Math.max(1, Math.min(31, Math.floor(day)));
    this.save();
  }

  registerPayment(clientEmail: string) {
    const email = clientEmail.trim().toLowerCase();
    const now = new Date().toISOString();
    this.data.entries = this.data.entries.map((entry) => entry.clientEmail === email && entry.decision === "billable" && (entry.paymentStatus || "unpaid") === "unpaid"
      ? { ...entry, paymentStatus: "paid", paidAt: now, updatedAt: now }
      : entry);
    this.data.lastPayments[email] = now;
    this.save();
  }

  setMonthlyTotal(clientEmail: string, amountCents: number, month = this.currentMonth()) {
    const email = clientEmail.trim().toLowerCase();
    this.data.monthlyTotalOverrides[this.monthlyTotalKey(email, month)] = this.normalizeAmount(amountCents);
    this.save();
  }

  snapshot(month = this.currentMonth()): AdminImageUsageSnapshot {
    const entries = this.data.entries.filter((entry) => entry.createdAt.slice(0, 7) === month);
    const overrideEmails = Object.keys(this.data.monthlyTotalOverrides).filter((key) => key.startsWith(`${month}:`)).map((key) => key.slice(month.length + 1));
    const emails = new Set([...Object.keys(this.data.defaultAmounts), ...Object.keys(this.data.routePrices), ...Object.keys(this.data.prepaidRoutes), ...Object.keys(this.data.dueDays), ...Object.keys(this.data.paymentEveryRoutes), ...Object.keys(this.data.billAllValidatedRoutes), ...overrideEmails, ...this.data.entries.map((entry) => entry.clientEmail)]);
    const clients = Array.from(emails).map((email) => this.summary(email, month, entries)).sort((a, b) => b.amountCents - a.amountCents || a.clientEmail.localeCompare(b.clientEmail));
    return {
      month,
      entries,
      ledgerEntries: this.data.entries.slice(0, 2_000),
      clients,
      totals: {
        total: entries.length,
        pending: entries.filter((entry) => entry.decision === "pending").length,
        billable: entries.filter((entry) => entry.decision === "billable").length,
        excluded: entries.filter((entry) => entry.decision === "excluded").length,
        detected: entries.filter((entry) => entry.result === "detected").length,
        amountCents: clients.reduce((total, client) => total + client.amountCents, 0),
        unpaidRoutes: clients.reduce((total, client) => total + client.unpaidRoutes, 0)
      }
    };
  }

  clientSnapshot(clientEmail: string, month = this.currentMonth()): ClientImageUsageSnapshot {
    const email = clientEmail.trim().toLowerCase();
    const allEntries = this.data.entries.filter((entry) => entry.clientEmail === email);
    const entries = allEntries.filter((entry) => entry.createdAt.slice(0, 7) === month);
    const unpaid = allEntries.filter((entry) => entry.decision === "billable" && (entry.paymentStatus || "unpaid") === "unpaid");
    const nextDue = this.nextDueDate(email, new Date());
    const daysUntilDue = Math.max(0, Math.ceil((nextDue.getTime() - Date.now()) / 86_400_000));
    const amountCents = unpaid.reduce((total, entry) => total + entry.amountCents, 0);
    const latestRoute = allEntries.filter((entry) => entry.decision === "billable" && entry.routeDispatchId)
      .sort((left, right) => Date.parse(right.reviewedAt || right.updatedAt) - Date.parse(left.reviewedAt || left.updatedAt))[0];
    const latestNoticeText = latestRoute
      ? latestRoute.paymentStatus === "prepaid"
        ? `Rota ${latestRoute.gaiola || latestRoute.route || "confirmada"} confirmada e adicionada à sua relação de rotas.`
        : `Rota ${latestRoute.gaiola || latestRoute.route || "confirmada"} validada e adicionada ao seu saldo: ${(latestRoute.amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`
      : undefined;
    return {
      month,
      amountCents,
      unpaidRoutes: unpaid.length,
      dueDay: this.dueDay(email),
      dueDate: nextDue.toISOString(),
      daysUntilDue,
      latestNotice: latestRoute && latestNoticeText ? { id: latestRoute.routeDispatchId!, text: latestNoticeText } : undefined,
      billingReminder: this.paymentEveryRoutes(email) > 0
        ? unpaid.length >= this.paymentEveryRoutes(email)
          ? `${unpaid.length} rota(s) confirmadas desde o último pagamento. Ciclo de ${this.paymentEveryRoutes(email)} rotas: saldo atual ${(amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`
          : undefined
        : unpaid.length && daysUntilDue <= 3
          ? `Faltam ${daysUntilDue} dia(s) para o vencimento (${nextDue.toLocaleDateString("pt-BR")}). ${unpaid.length} rota(s) em aberto: ${(amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`
          : undefined
    };
  }

  private summary(clientEmail: string, month: string, entries: ImageUsageEntry[]) {
    const clientEntries = entries.filter((entry) => entry.clientEmail === clientEmail);
    const allClientEntries = this.data.entries.filter((entry) => entry.clientEmail === clientEmail);
    const unpaidEntries = allClientEntries.filter((entry) => entry.decision === "billable" && (entry.paymentStatus || "unpaid") === "unpaid");
    const calculatedAmountCents = unpaidEntries.reduce((total, entry) => total + entry.amountCents, 0);
    const manualTotalAmountCents = this.data.monthlyTotalOverrides[this.monthlyTotalKey(clientEmail, month)];
    return {
      clientEmail,
      month,
      total: clientEntries.length,
      pending: clientEntries.filter((entry) => entry.decision === "pending").length,
      billable: clientEntries.filter((entry) => entry.decision === "billable").length,
      excluded: clientEntries.filter((entry) => entry.decision === "excluded").length,
      detected: clientEntries.filter((entry) => entry.result === "detected").length,
      amountCents: calculatedAmountCents,
      defaultAmountCents: this.routePrice(clientEmail),
      manualTotalAmountCents,
      billAllValidatedRoutes: true,
      routePriceCents: this.routePrice(clientEmail),
      prepaidRoutesRemaining: this.data.prepaidRoutes[clientEmail] || 0,
      creditBalanceCents: this.data.creditBalances[clientEmail] || 0,
      dueDay: this.dueDay(clientEmail),
      paymentEveryRoutes: this.paymentEveryRoutes(clientEmail),
      lastPaymentAt: this.data.lastPayments[clientEmail],
      unpaidRoutes: unpaidEntries.length
    };
  }

  private findLegacyAnalysisForRoute(input: ValidatedRouteUsageInput, clientEmail: string) {
    const targetTime = Date.parse(input.analysisFinishedAt || input.analysisStartedAt || "");
    const targetGaiola = String(input.gaiola || "").trim().toLowerCase();
    const targetRoute = String(input.route || "").trim().toLowerCase();
    return this.data.entries
      .filter((entry) => entry.clientEmail === clientEmail && entry.result === "detected" && !entry.routeDispatchId)
      .map((entry) => {
        const entryTime = Date.parse(entry.analysisFinishedAt || entry.analysisStartedAt || entry.createdAt);
        const distanceMs = Number.isFinite(targetTime) && Number.isFinite(entryTime) ? Math.abs(entryTime - targetTime) : Number.MAX_SAFE_INTEGER;
        const sameGaiola = Boolean(targetGaiola && String(entry.gaiola || "").trim().toLowerCase() === targetGaiola);
        const sameRoute = Boolean(targetRoute && String(entry.route || "").trim().toLowerCase() === targetRoute);
        return { entry, distanceMs, sameIdentity: sameGaiola || sameRoute };
      })
      .filter((candidate) => candidate.sameIdentity || candidate.distanceMs <= 2 * 60 * 60_000)
      .sort((left, right) => Number(right.sameIdentity) - Number(left.sameIdentity) || left.distanceMs - right.distanceMs)[0]?.entry;
  }

  private defaultAmount(clientEmail: string) {
    return this.normalizeAmount(this.data.defaultAmounts[clientEmail] ?? 70);
  }

  private routePrice(clientEmail: string) {
    return this.normalizeAmount(this.data.routePrices[clientEmail] ?? this.defaultAmount(clientEmail));
  }

  private dueDay(clientEmail: string) {
    return this.data.dueDays[clientEmail] || 15;
  }

  paymentEveryRoutes(clientEmail: string) {
    const email = clientEmail.trim().toLowerCase();
    const configured = this.data.paymentEveryRoutes[email];
    if (configured !== undefined) return configured;
    return email.split("@")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes("fernando") ? 10 : 0;
  }

  setPaymentEveryRoutes(clientEmail: string, quantity: number) {
    this.data.paymentEveryRoutes[clientEmail.trim().toLowerCase()] = Math.max(0, Math.min(10_000, Math.floor(quantity)));
    this.save();
  }

  private nextDueDate(clientEmail: string, now: Date) {
    const day = this.dueDay(clientEmail);
    const dateForMonth = (year: number, month: number) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return new Date(year, month, Math.min(day, lastDay), 23, 59, 59, 999);
    };
    let due = dateForMonth(now.getFullYear(), now.getMonth());
    if (due.getTime() <= now.getTime()) due = dateForMonth(now.getFullYear(), now.getMonth() + 1);
    return due;
  }

  private monthlyTotalKey(clientEmail: string, month: string) {
    return `${month}:${clientEmail}`;
  }

  private normalizeAmount(value: number) {
    return Math.max(0, Math.min(10_000_000, Math.round(Number(value) || 0)));
  }

  private currentMonth() {
    return new Date().toISOString().slice(0, 7);
  }

  private load(): StoredImageUsage {
    const backupPath = `${this.filePath}.bak`;
    for (const candidate of [this.filePath, backupPath]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (parsed && Array.isArray(parsed.entries) && parsed.defaultAmounts && typeof parsed.defaultAmounts === "object") {
          return {
            entries: parsed.entries,
            defaultAmounts: parsed.defaultAmounts,
            monthlyTotalOverrides: parsed.monthlyTotalOverrides && typeof parsed.monthlyTotalOverrides === "object" ? parsed.monthlyTotalOverrides : {},
            billAllValidatedRoutes: parsed.billAllValidatedRoutes && typeof parsed.billAllValidatedRoutes === "object" ? parsed.billAllValidatedRoutes : {},
            routePrices: parsed.routePrices && typeof parsed.routePrices === "object" ? parsed.routePrices : {},
            prepaidRoutes: parsed.prepaidRoutes && typeof parsed.prepaidRoutes === "object" ? parsed.prepaidRoutes : {},
            dueDays: parsed.dueDays && typeof parsed.dueDays === "object" ? parsed.dueDays : {},
            lastPayments: parsed.lastPayments && typeof parsed.lastPayments === "object" ? parsed.lastPayments : {},
            paymentEveryRoutes: parsed.paymentEveryRoutes && typeof parsed.paymentEveryRoutes === "object" ? parsed.paymentEveryRoutes : {},
            deletedRoutes: parsed.deletedRoutes && typeof parsed.deletedRoutes === "object" ? parsed.deletedRoutes : {},
            creditBalances: parsed.creditBalances && typeof parsed.creditBalances === "object" ? parsed.creditBalances : {}
          };
        }
      } catch {
        // Tenta o backup antes de iniciar um registro vazio.
      }
    }
    if (fs.existsSync(this.filePath) || fs.existsSync(backupPath)) throw new Error("Registro de consumo inválido. Restaure um backup antes de gravar novos dados.");
    return { entries: [], defaultAmounts: {}, monthlyTotalOverrides: {}, billAllValidatedRoutes: {}, routePrices: {}, prepaidRoutes: {}, dueDays: {}, paymentEveryRoutes: {}, lastPayments: {}, deletedRoutes: {}, creditBalances: {} };
  }

  private save() {
    if (this.hasValidData(this.filePath)) writeJsonAtomic(`${this.filePath}.bak`, JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    writeJsonAtomic(this.filePath, this.data);
  }

  private hasValidData(filePath: string) {
    if (!fs.existsSync(filePath)) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return Boolean(parsed && Array.isArray(parsed.entries));
    } catch {
      return false;
    }
  }
}
