export const DAILY_LATE_FEE_CENTS = 50;
export const BILLING_PIX_KEY = "91980984781";
export const BILLING_PIX_RECEIVER = "Ruan Souza da Silva";

export function billingDayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}

export function paymentNoticePhase(amountCents: number, overdue: boolean, daysUntilDue: number, dueDate?: string, blocked = false) {
  if (blocked) return "blocked" as const;
  if (amountCents <= 0) return undefined;
  if (overdue) return "overdue" as const;
  if (dueDate && daysUntilDue === 0) return "due_today" as const;
  if (dueDate && daysUntilDue > 0 && daysUntilDue <= 3) return "upcoming" as const;
  return undefined;
}
