import { readJsonFile, writeJsonAtomic } from "./storageJson";
import { hashPassword, isPasswordHash, verifyPasswordSync } from "./passwords";
import { PasswordVault } from "./passwordVault";
import { validateEmail } from "./httpSafety";
import { DispatchMatchupRule, LoginEvent, PanelUserRole } from "./shared/types";

export type StoredPanelUser = {
  email: string;
  password: string;
  passwordEncrypted?: string;
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
  loginHistory: LoginEvent[];
  source?: "environment" | "panel";
  sessionVersion?: number;
};

const MAX_LOGIN_HISTORY = 100;
const MAX_USAGE_GAP_MS = 1000 * 60 * 5;

export class PanelUserStore {
  private readonly vault: PasswordVault;
  constructor(private readonly filePath: string) { this.vault = new PasswordVault(filePath); }

  revealPassword(email: string) {
    const user = this.load().find(item => item.email === email.trim().toLowerCase());
    if (!user) return undefined;
    const password = this.vault.open(user.passwordEncrypted, user.email);
    return password !== undefined && verifyPasswordSync(password, user.password) ? password : undefined;
  }

  rememberPassword(email: string, password: string) {
    if (!password || isPasswordHash(password)) return;
    const users = this.load(), user = users.find(item => item.email === email.trim().toLowerCase());
    if (!user || !verifyPasswordSync(password, user.password) || this.revealPassword(user.email) === password) return;
    user.passwordEncrypted = this.vault.seal(password, user.email);
    this.save(users);
  }

  all() {
    return this.load();
  }

  upsert(input: {
    email: string;
    password?: string;
    role?: PanelUserRole;
    blocked?: boolean;
    color?: string;
    dispatchPriorityLevel?: number;
    dispatchBeatsEmail?: string;
    dispatchAdvantageMs?: number;
    dispatchMatchups?: DispatchMatchupRule[];
    source?: "environment" | "panel";
  }) {
    const email = validateEmail(input.email);
    if (input.password && input.password.length > 1024) throw new Error("Senha muito longa.");

    const now = new Date().toISOString();
    const users = this.load();
    const existing = users.find((user) => user.email === email);
    if (existing) {
      if ((input.password !== undefined && input.password.trim() && input.password !== existing.password)
        || (input.role !== undefined && input.role !== existing.role)
        || (input.blocked !== undefined && input.blocked !== existing.blocked)) {
        existing.sessionVersion = (existing.sessionVersion || 0) + 1;
      }
      if (input.password !== undefined && input.password.trim()) {
        if (!isPasswordHash(input.password)) existing.passwordEncrypted = this.vault.seal(input.password, email);
        else if (input.password !== existing.password) delete existing.passwordEncrypted;
        existing.password = hashPassword(input.password);
      }
      if (input.source) existing.source = input.source;
      if (input.role) existing.role = input.role;
      if (input.blocked !== undefined) existing.blocked = input.blocked;
      if (input.color !== undefined) existing.color = normalizeUserColor(input.color, existing.email);
      if (input.dispatchPriorityLevel !== undefined) existing.dispatchPriorityLevel = normalizeDispatchPriorityLevel(input.dispatchPriorityLevel);
      if (input.dispatchBeatsEmail !== undefined) existing.dispatchBeatsEmail = normalizeDispatchBeatsEmail(input.dispatchBeatsEmail, email);
      if (input.dispatchAdvantageMs !== undefined) existing.dispatchAdvantageMs = normalizeDispatchAdvantageMs(input.dispatchAdvantageMs);
      if (input.dispatchMatchups !== undefined) existing.dispatchMatchups = normalizeDispatchMatchups(input.dispatchMatchups, email);
      existing.updatedAt = now;
      this.save(users);
      return existing;
    }

    if (!input.password?.trim()) throw new Error("Senha obrigatória para novo usuário.");

    const user: StoredPanelUser = {
      email,
      password: hashPassword(input.password),
      passwordEncrypted: !isPasswordHash(input.password) ? this.vault.seal(input.password, email) : undefined,
      source: input.source || "panel",
      sessionVersion: 0,
      role: input.role || "client",
      blocked: Boolean(input.blocked),
      color: normalizeUserColor(input.color, email),
      dispatchPriorityLevel: normalizeDispatchPriorityLevel(input.dispatchPriorityLevel),
      dispatchBeatsEmail: normalizeDispatchBeatsEmail(input.dispatchBeatsEmail, email),
      dispatchAdvantageMs: normalizeDispatchAdvantageMs(input.dispatchAdvantageMs),
      dispatchMatchups: normalizeDispatchMatchups(input.dispatchMatchups, email),
      createdAt: now,
      updatedAt: now,
      totalUsageMs: 0,
      loginHistory: []
    };
    this.save([...users, user]);
    return user;
  }

  rename(email: string, nextEmail: string) {
    const normalized = validateEmail(nextEmail);
    const users = this.load();
    if (users.some((user) => user.email === normalized && user.email !== email)) throw new Error("Email já cadastrado.");
    const user = users.find((item) => item.email === email);
    if (!user) throw new Error("Usuário não encontrado.");
    const password = this.vault.open(user.passwordEncrypted, user.email);
    user.passwordEncrypted = password === undefined ? undefined : this.vault.seal(password, normalized);
    user.email = normalized;
    user.source = "panel";
    this.save(users);
  }

  remove(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    this.save(this.load().filter((user) => user.email !== normalizedEmail));
  }

  recordLogin(email: string, ip: string, userAgent: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const now = new Date().toISOString();
    this.save(
      this.load().map((user) => {
        if (user.email !== normalizedEmail) return user;
        return {
          ...user,
          lastLoginAt: now,
          lastSeenAt: now,
          loginHistory: [
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              timestamp: now,
              ip,
              userAgent
            },
            ...user.loginHistory
          ].slice(0, MAX_LOGIN_HISTORY),
          updatedAt: now
        };
      })
    );
  }

  touch(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    this.save(
      this.load().map((user) => {
        if (user.email !== normalizedEmail) return user;
        const lastSeenMs = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
        const delta = lastSeenMs && nowMs - lastSeenMs <= MAX_USAGE_GAP_MS ? nowMs - lastSeenMs : 0;
        return {
          ...user,
          lastSeenAt: now,
          totalUsageMs: user.totalUsageMs + delta
        };
      })
    );
  }

  acknowledgeRelease(email: string, releaseId: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedReleaseId = releaseId.trim();
    if (!normalizedEmail || !normalizedReleaseId) return undefined;

    const now = new Date().toISOString();
    let updatedUser: StoredPanelUser | undefined;
    const users = this.load().map((user) => {
      if (user.email !== normalizedEmail) return user;
      updatedUser = {
        ...user,
        lastSeenReleaseId: normalizedReleaseId,
        lastSeenReleaseAt: now,
        updatedAt: now
      };
      return updatedUser;
    });
    if (updatedUser) this.save(users);
    return updatedUser;
  }

  private load(): StoredPanelUser[] {
    const data = readJsonFile<unknown[]>(this.filePath, () => [], Array.isArray);
    return data.map((item) => this.normalize(item)).filter(Boolean) as StoredPanelUser[];
  }

  private save(users: StoredPanelUser[]) {
    writeJsonAtomic(this.filePath, users.map((user) => ({ ...user, passwordEncrypted: !isPasswordHash(user.password) ? this.vault.seal(user.password, user.email) : user.passwordEncrypted, password: hashPassword(user.password) })));
  }

  private normalize(input: any): StoredPanelUser | undefined {
    if (!input || typeof input.email !== "string" || typeof input.password !== "string") return undefined;
    const now = new Date().toISOString();
    return {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      passwordEncrypted: typeof input.passwordEncrypted === "string" ? input.passwordEncrypted : undefined,
      source: input.source === "panel" ? "panel" : "environment",
      sessionVersion: Number.isSafeInteger(input.sessionVersion) && input.sessionVersion >= 0 ? input.sessionVersion : 0,
      role: input.role === "admin" ? "admin" : "client",
      blocked: Boolean(input.blocked),
      color: normalizeUserColor(input.color, input.email),
      dispatchPriorityLevel: normalizeDispatchPriorityLevel(input.dispatchPriorityLevel),
      dispatchBeatsEmail: normalizeDispatchBeatsEmail(input.dispatchBeatsEmail, input.email),
      dispatchAdvantageMs: normalizeDispatchAdvantageMs(input.dispatchAdvantageMs),
      dispatchMatchups: normalizeDispatchMatchups(
        Array.isArray(input.dispatchMatchups) ? input.dispatchMatchups : input.dispatchBeatsEmail ? [{ opponentEmail: input.dispatchBeatsEmail, outcome: "wins", delayMs: input.dispatchAdvantageMs }] : [],
        input.email
      ),
      createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
      updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
      lastLoginAt: typeof input.lastLoginAt === "string" ? input.lastLoginAt : undefined,
      lastSeenAt: typeof input.lastSeenAt === "string" ? input.lastSeenAt : undefined,
      lastSeenReleaseId: typeof input.lastSeenReleaseId === "string" ? input.lastSeenReleaseId : undefined,
      lastSeenReleaseAt: typeof input.lastSeenReleaseAt === "string" ? input.lastSeenReleaseAt : undefined,
      totalUsageMs: Number.isFinite(Number(input.totalUsageMs)) ? Math.max(0, Number(input.totalUsageMs)) : 0,
      loginHistory: Array.isArray(input.loginHistory)
        ? input.loginHistory.filter((event: unknown) => event && typeof event === "object").map((event: any) => ({
            id: typeof event.id === "string" ? event.id : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: typeof event.timestamp === "string" ? event.timestamp : now,
            ip: typeof event.ip === "string" ? event.ip : "",
            userAgent: typeof event.userAgent === "string" ? event.userAgent : ""
          })).slice(0, MAX_LOGIN_HISTORY)
        : []
    };
  }
}

const USER_COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#f97316", "#ec4899"];

export function defaultUserColor(email: string) {
  const normalized = String(email || "").toLowerCase();
  const hash = normalized.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  return USER_COLORS[hash % USER_COLORS.length];
}

export function normalizeUserColor(value: string | undefined, email: string) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : defaultUserColor(email);
}

export function normalizeDispatchPriorityLevel(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.min(5, Math.max(0, Math.floor(numberValue)));
}

export function normalizeDispatchBeatsEmail(value: unknown, ownEmail = "") {
  const email = String(value || "").trim().toLowerCase();
  return email && email !== String(ownEmail || "").trim().toLowerCase() ? email : undefined;
}

export function normalizeDispatchAdvantageMs(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 400;
  return Math.min(10_000, Math.max(400, Math.round(numberValue)));
}

export function normalizeDispatchMatchups(value: unknown, ownEmail = ""): DispatchMatchupRule[] {
  if (!Array.isArray(value)) return [];
  const own = String(ownEmail || "").trim().toLowerCase();
  const unique = new Map<string, DispatchMatchupRule>();
  for (const item of value) {
    const opponentEmail = String(item?.opponentEmail || "").trim().toLowerCase();
    if (!opponentEmail || opponentEmail === own) continue;
    const outcome = item?.outcome === "loses" ? "loses" : "wins";
    unique.set(opponentEmail, { opponentEmail, outcome, delayMs: normalizeDispatchAdvantageMs(item?.delayMs) });
  }


  return Array.from(unique.values());
}
