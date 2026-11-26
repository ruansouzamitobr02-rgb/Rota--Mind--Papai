import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Clock3, Copy, RefreshCw, X } from "lucide-react";
import { ClientImageUsageSnapshot } from "../../../shared/types";
import { BILLING_PIX_KEY, BILLING_PIX_RECEIVER, billingDayKey, paymentNoticePhase } from "../../../shared/billingPolicy";
import { dismissClientBillingNotice, getClientBillingStatus } from "../api";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
type Dismissal = { key: string; day: string };

export function ClientDebtNotice({ usage, suppressed, accountEmail, onReturnToAdmin }: {
  usage?: ClientImageUsageSnapshot; suppressed: boolean; accountEmail: string; onReturnToAdmin?: () => void | Promise<void>;
}) {
  const cacheKey = `billing-notice-dismissed:${accountEmail.trim().toLowerCase()}`;
  const [finance, setFinance] = useState(usage);
  const [dismissed, setDismissed] = useState<Dismissal | undefined>(() => {
    try { return JSON.parse(localStorage.getItem(cacheKey) || "null") || undefined; } catch { return undefined; }
  });
  const [manualOpen, setManualOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const usageVersion = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const blocked = Boolean(finance?.paymentBlocked);
  const phase = blocked ? "blocked" : finance?.billingNotice?.phase || (finance && paymentNoticePhase(finance.amountCents, Boolean(finance.overdue), finance.daysUntilDue || 0, finance.paymentEveryRoutes ? undefined : finance.dueDate, finance.paymentBlocked));
  const overdue = Boolean(finance?.overdue || finance?.paymentBlocked);
  const noticeKey = finance?.billingNotice?.key || finance?.dueDate || "payment";
  const day = finance?.billingNotice?.day || billingDayKey(new Date(clock));
  const hiddenToday = finance?.billingNotice?.dismissedToday || dismissed?.key === noticeKey && dismissed?.day === day;
  const open = blocked || Boolean(phase && !suppressed && (!hiddenToday || manualOpen));
  const dueDate = finance?.dueDate ? new Date(finance.dueDate).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "o prazo combinado";
  const title = phase === "blocked" ? "Bot bloqueado por pagamento pendente" : phase === "due_today" ? "Hoje é o dia do pagamento" : phase === "upcoming" ? `Seu pagamento vence em ${finance?.daysUntilDue} dia(s)` : "Seu pagamento está em atraso";

  useEffect(() => { usageVersion.current++; setFinance(usage); setFeedback(""); }, [usage]);

  useEffect(() => {
    if (suppressed && !blocked || window.botApi) { setChecking(false); return; }
    let alive = true;
    let inFlight: AbortController | undefined;
    const refresh = async (manual = false) => {
      if (!alive || inFlight || document.visibilityState === "hidden") return;
      const controller = new AbortController(), version = usageVersion.current;
      inFlight = controller;
      const deadline = window.setTimeout(() => controller.abort(), 10_000);
      setChecking(true);
      try {
        const next = await getClientBillingStatus(controller.signal);
        if (!alive || controller.signal.aborted || version !== usageVersion.current) return;
        usageVersion.current++; setFinance(next); setClock(Date.now());
        if (manual) setFeedback(next.amountCents > 0 ? "O pagamento ainda não foi registrado. Se já pagou, fale com o administrador." : "Situação atualizada.");
      } catch {
        if (alive && !controller.signal.aborted && manual) setFeedback("Não foi possível conferir agora. Tente novamente em instantes.");
      } finally {
        window.clearTimeout(deadline);
        if (inFlight === controller) inFlight = undefined;
        if (alive) setChecking(false);
      }
    };
    refreshRef.current = () => refresh(true);
    const resume = () => { if (document.visibilityState !== "hidden") { setClock(Date.now()); void refresh(); } };
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    void refresh();
    return () => {
      alive = false; inFlight?.abort(); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume);
      refreshRef.current = async () => undefined;
    };
  }, [suppressed, blocked, accountEmail]);

  const dismiss = () => {
    if (blocked) return;
    const next = { key: noticeKey, day }, version = usageVersion.current;
    setDismissed(next); setManualOpen(false); setFeedback("");
    try { localStorage.setItem(cacheKey, JSON.stringify(next)); } catch { /* The server also persists the dismissal. */ }
    if (finance?.billingNotice) void dismissClientBillingNotice(noticeKey).then(next => {
      if (version === usageVersion.current) { usageVersion.current++; setFinance(next); }
    }).catch(() => undefined);
  };
  useEffect(() => { setManualOpen(false); }, [noticeKey, Boolean(phase)]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null, closeElement = closeRef.current;
    const dialog = dialogRef.current;
    (closeElement || dialog?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (blocked) { event.preventDefault(); event.stopImmediatePropagation(); } else dismiss(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keys, true);
    const inertElements: Array<[HTMLElement, boolean]> = [];
    if (blocked) {
      let branch = dialog?.parentElement;
      while (branch?.parentElement) {
        for (const sibling of Array.from(branch.parentElement.children)) if (sibling !== branch && sibling instanceof HTMLElement) { inertElements.push([sibling, sibling.inert]); sibling.inert = true; }
        branch = branch.parentElement;
        if (branch === document.body) break;
      }
    }
    return () => {
      document.removeEventListener("keydown", keys, true);
      for (const [element, previous] of inertElements) element.inert = previous;
      if (previousFocus?.isConnected && (document.activeElement === closeElement || document.activeElement === document.body)) previousFocus.focus({ preventScroll: true });
    };
  }, [open, noticeKey, day, blocked]);

  async function copyPix() {
    try { await navigator.clipboard.writeText(BILLING_PIX_KEY); setFeedback("Chave Pix copiada."); }
    catch { setFeedback("Selecione a chave Pix exibida e copie para o aplicativo do seu banco."); }
  }

  if (!phase) return null;
  return <>
    {overdue ? <div className={`client-debt-frame ${blocked ? "blocked" : ""}`} aria-hidden="true" /> : null}
    {!suppressed ? <section className={`client-debt-banner ${phase}`} aria-label="Aviso de pagamento">
      <CalendarDays size={18} /><span><strong>{phase === "upcoming" ? "Pagamento próximo" : phase === "due_today" ? "Pagamento vence hoje" : phase === "blocked" ? "Bot bloqueado por atraso" : "Pagamento pendente"}</strong><small>{money(finance!.amountCents)} · {dueDate}</small></span>
      <button type="button" className="button" onClick={() => setManualOpen(true)}>Ver aviso</button>
    </section> : null}
    {open ? <div className={`modal-backdrop client-debt-backdrop ${blocked ? "payment-locked" : ""}`}>
      <section ref={dialogRef} className={`client-debt-dialog ${blocked ? "payment-locked" : ""}`} role="dialog" aria-modal="true" aria-labelledby="client-debt-title" aria-describedby="client-debt-description">
        {!blocked ? <button ref={closeRef} className="icon-button client-debt-close" type="button" aria-label="Fechar aviso de pagamento" onClick={dismiss}><X size={20} /></button> : null}
        <div className="client-debt-icon">{overdue ? <AlertTriangle size={30} /> : <CalendarDays size={30} />}</div>
        <p className="client-debt-eyebrow">{blocked ? "Acesso suspenso" : "Um lembrete sobre seu acerto"}</p>
        <h2 id="client-debt-title">{title}</h2>
        <div className="client-debt-amount"><small>{phase === "upcoming" ? "Valor para o vencimento" : "Seu saldo em aberto"}</small><strong>{money(finance!.amountCents)}</strong></div>
        {finance!.dailyLateFeeCents && (finance!.lateFeeCents || 0) > 0 ? <div className="client-debt-breakdown"><span>Saldo combinado <b>{money(finance!.principalCents || 0)}</b></span><span>Taxa de atraso · {finance!.daysOverdue || 0} dia(s) <b>{money(finance!.lateFeeCents || 0)}</b></span></div> : null}
        <p id="client-debt-description">{phase === "upcoming" ? `Seu pagamento está previsto para ${dueDate}. Organize seu acerto; ao fechar, o próximo alerta será amanhã.` : phase === "due_today" ? `Seu pagamento vence hoje (${dueDate}).` : phase === "blocked" ? "O administrador bloqueou o uso do bot por uma pendência financeira. Consulte o saldo e combine a regularização." : finance!.paymentEveryRoutes ? `Seu ciclo de ${finance!.paymentEveryRoutes} rotas foi atingido.` : `O pagamento venceu em ${dueDate}.`}</p>
        {finance!.dailyLateFeeCents ? <p className="client-debt-fee-warning">{phase === "due_today" ? "Pague hoje para evitar a taxa. A partir de amanhã, " : phase === "upcoming" ? "Após o vencimento, " : "Enquanto houver saldo em atraso, "}{money(finance!.dailyLateFeeCents)} será acrescentado por dia de atraso.</p> : null}
        {phase !== "upcoming" ? <div className="client-debt-pix"><small>Pague pelo Pix</small><strong>{BILLING_PIX_KEY}</strong><span>{BILLING_PIX_RECEIVER}</span><button className="button" type="button" onClick={() => void copyPix()}><Copy size={16} />Copiar chave Pix</button></div> : null}
        <div className="client-debt-note"><Clock3 size={17} /><span>{finance!.paymentBlocked ? "O administrador bloqueou o uso do bot por este débito. Após conferir e registrar o pagamento, o acesso será liberado." : "Este lembrete não aparece enquanto o bot estiver armado. Ao fechar, o próximo alerta automático será amanhã."}</span></div>
        {!blocked ? <button className="button client-debt-later" type="button" onClick={dismiss}>Fechar · lembrar amanhã</button> : <p className="client-debt-locked-message">O uso do bot está suspenso. Este aviso permanece até o administrador confirmar o pagamento ou liberar seu acesso.</p>}
        <button className="button client-debt-refresh" type="button" disabled={checking} onClick={() => void refreshRef.current()}><RefreshCw size={16} className={checking ? "spin" : ""} />{checking ? "Conferindo…" : "Já pagou? Atualizar situação"}</button>
        <small className="client-debt-confirmation">O aviso some quando o administrador registra o pagamento.</small>
        {blocked && onReturnToAdmin ? <button type="button" className="button" onClick={() => void onReturnToAdmin()}>Voltar ao administrador</button> : null}
        {feedback ? <p className="client-debt-feedback" role="status">{feedback}</p> : null}
      </section>
    </div> : null}
  </>;
}
