const DAY_MS = 86_400_000;

function brazilDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}

/** Keep an unpaid period's deadline instead of moving it forward every month. */
export function getBillingDeadline(dueDay: number, now: Date, firstUnpaidAt?: string, lastPaymentAt?: string) {
  const today = brazilDate(now);
  let anchor = firstUnpaidAt && Number.isFinite(Date.parse(firstUnpaidAt))
    ? brazilDate(new Date(firstUnpaidAt)) : `${today.slice(0, 7)}-01`;
  const paid = lastPaymentAt && Number.isFinite(Date.parse(lastPaymentAt)) ? brazilDate(new Date(lastPaymentAt)) : undefined;
  if (paid && paid > anchor) anchor = paid;
  const [year, month] = anchor.split("-").map(Number);
  const inMonth = (monthIndex: number) => {
    const date = new Date(Date.UTC(year, monthIndex, 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(Math.max(1, dueDay), lastDay)).padStart(2, "0")}`;
  };
  let deadline = inMonth(month - 1);
  if (deadline < anchor || paid && deadline <= paid) deadline = inMonth(month);
  const days = Math.round((Date.parse(`${deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);
  return { dueDate: `${deadline}T23:59:59.999-03:00`, daysUntilDue: Math.max(0, days), daysOverdue: Math.max(0, -days) };
}
