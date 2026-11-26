import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock3, RefreshCw, X } from "lucide-react";
import { ClientImageUsageSnapshot } from "../../../shared/types";
import { getClientBillingStatus } from "../api";

const REMIND_AFTER_MS = 5 * 60_000;
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function ClientDebtNotice({ usage, suppressed, accountEmail }: {
  usage?: ClientImageUsageSnapshot; suppressed: boolean; accountEmail: string;
}) {
  const [finance, setFinance] = useState(usage);
  const [remindAt, setRemindAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const usageVersion = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overdue = Boolean(finance?.overdue && finance.amountCents > 0);
  const open = overdue && !suppressed && clock >= remindAt;

  useEffect(() => { usageVersion.current++; setFinance(usage); setFeedback(""); }, [usage]);

  useEffect(() => {
    // Never add a billing request or timer to the armed bot's critical path.
    if (suppressed || window.botApi) { setChecking(false); return; }
    let alive = true;
    let inFlight: AbortController | undefined;
    const refresh = async () => {
      if (!alive || inFlight || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      const version = usageVersion.current;
      inFlight = controller;
      const deadline = window.setTimeout(() => controller.abort(), 10_000);
      setChecking(true);
      try {
        const next = await getClientBillingStatus(controller.signal);
        if (!alive || controller.signal.aborted || version !== usageVersion.current) return;
        setFinance(next);
        setFeedback(next.overdue ? "O pagamento ainda não foi registrado. Se já pagou, fale com o administrador." : "Situação atualizada.");
      } catch {
        if (alive && !controller.signal.aborted) setFeedback("Não foi possível conferir agora. Tente novamente em instantes.");
      } finally {
        window.clearTimeout(deadline);
        if (inFlight === controller) inFlight = undefined;
        if (alive) setChecking(false);
      }
    };
    refreshRef.current = refresh;
    const resume = () => { if (document.visibilityState !== "hidden") { setClock(Date.now()); void refresh(); } };
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    void refresh();
    return () => {
      alive = false;
      inFlight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      refreshRef.current = async () => undefined;
    };
  }, [suppressed, accountEmail]);

  useEffect(() => {
    if (suppressed) return;
    setClock(Date.now());
    const delay = remindAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), delay + 20);
    return () => window.clearTimeout(timer);
  }, [remindAt, suppressed]);

  const dismiss = () => { setRemindAt(Date.now() + REMIND_AFTER_MS); setFeedback(""); };
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const closeElement = closeRef.current;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
      if (event.key !== "Tab") return;
      const buttons = Array.from(closeElement?.closest("[role=dialog]")?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (previousFocus?.isConnected && (document.activeElement === closeElement || document.activeElement === document.body)) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  if (!overdue) return null;
  return <>
    <div className="client-debt-frame" aria-hidden="true" />
    {!suppressed ? <section className="client-debt-banner" aria-label="Pagamento pendente">
      <AlertTriangle size={18} /><span><strong>Pagamento pendente</strong><small>{money(finance!.amountCents)} em aberto</small></span>
      <button type="button" className="button" onClick={() => { setRemindAt(0); setClock(Date.now()); }}>Ver aviso</button>
    </section> : null}
    {open ? <div className="modal-backdrop client-debt-backdrop">
      <section className="client-debt-dialog" role="dialog" aria-modal="true" aria-labelledby="client-debt-title" aria-describedby="client-debt-description">
        <button ref={closeRef} className="icon-button client-debt-close" type="button" aria-label="Fechar aviso de pagamento" onClick={dismiss}><X size={20} /></button>
        <div className="client-debt-icon"><AlertTriangle size={30} /></div>
        <p className="client-debt-eyebrow">Um lembrete sobre seu acerto</p>
        <h2 id="client-debt-title">Você tem um pagamento pendente</h2>
        <div className="client-debt-amount"><small>Seu saldo em aberto</small><strong>{money(finance!.amountCents)}</strong></div>
        {finance!.dailyLateFeeCents ? <div className="client-debt-breakdown"><span>Saldo combinado <b>{money(finance!.principalCents || 0)}</b></span><span>Taxa de atraso · {finance!.daysOverdue || 0} dia(s) <b>{money(finance!.lateFeeCents || 0)}</b></span><small>Após o vencimento: R$ 1,00 de taxa por dia enquanto houver saldo em aberto.</small></div> : null}
        <p id="client-debt-description">{finance!.paymentEveryRoutes
          ? `Seu ciclo de ${finance!.paymentEveryRoutes} rotas foi atingido.`
          : `O pagamento venceu em ${new Date(finance!.dueDate!).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`}
          {" "}Combine o acerto com o administrador para regularizar seu saldo.</p>
        <div className="client-debt-note"><Clock3 size={17} /><span>Você pode continuar usando o bot. Este lembrete não aparece enquanto ele estiver armado.</span></div>
        <button className="button client-debt-later" type="button" onClick={dismiss}>Agora não · lembrar em 5 minutos</button>
        <button className="button client-debt-refresh" type="button" disabled={checking} onClick={() => void refreshRef.current()}><RefreshCw size={16} className={checking ? "spin" : ""} />{checking ? "Conferindo…" : "Já pagou? Atualizar situação"}</button>
        <small className="client-debt-confirmation">O aviso some quando o administrador registra o pagamento.</small>
        {feedback ? <p className="client-debt-feedback" role="status">{feedback}</p> : null}
      </section>
    </div> : null}
  </>;
}
