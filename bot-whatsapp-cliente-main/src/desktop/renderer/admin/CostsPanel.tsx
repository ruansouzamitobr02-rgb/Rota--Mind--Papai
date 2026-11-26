import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, CircleDollarSign, History, Save, Search, SlidersHorizontal, Wallet } from "lucide-react";
import { AdminImageUsageSnapshot, ClientFinanceSettings, ImageUsageClientSummary } from "../../../shared/types";
import { registerClientPayment, saveClientFinance, saveBillingSettings } from "../api";
import { parseMoneyInput } from "./usageDrafts";
import { getBillingDeadline, isBillingDate } from "../../../shared/billingDeadline";
import { DAILY_LATE_FEE_CENTS } from "../../../shared/billingPolicy";

const money = (cents = 0) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const inputMoney = (cents = 0) => (cents / 100).toFixed(2).replace(".", ",");
const date = (value?: string | null) => value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Sem data definida";
const name = (email: string) => email.split("@")[0];
const status = (client: ImageUsageClientSummary) => client.paymentBlocked ? "Bloqueado" : client.amountCents <= 0 ? "Quitado" : client.overdue ? "Em atraso" : "Em aberto";

type Props = { usage: AdminImageUsageSnapshot; clientEmails: string[]; clientFilter: string; search: string; onChange: (next: AdminImageUsageSnapshot) => void };

export function CostsPanel({ usage, clientEmails, clientFilter, search, onChange }: Props) {
  const [section, setSection] = useState("accounts");
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Todos");
  const all = clientEmails.map(email => usage.clients.find(client => client.clientEmail === email) || {
    clientEmail: email, month: usage.month, amountCents: 0, principalCents: 0, lateFeeCents: 0, routePriceCents: 70,
    total: 0, pending: 0, billable: 0, excluded: 0, detected: 0, unpaidRoutes: 0, defaultAmountCents: 70,
    prepaidRoutesRemaining: 0, dueDay: 15, paymentEveryRoutes: /fernando/i.test(email) ? 10 : 0, billAllValidatedRoutes: true
  } as ImageUsageClientSummary).filter(client => (clientFilter === "all" || client.clientEmail === clientFilter)
    && [search, query].every(term => client.clientEmail.toLowerCase().includes(term.trim().toLowerCase())));
  const rows = all.filter(client => filter === "Todos" || (filter === "Em atraso" ? client.overdue : status(client) === filter)).sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)) || b.amountCents - a.amountCents || a.clientEmail.localeCompare(b.clientEmail));
  const current = rows.find(client => client.clientEmail === selected) || rows[0];
  const total = all.reduce((sum, client) => sum + client.amountCents, 0);
  return <section className="finance-workspace">
    <header className="finance-heading"><div><p>Controle financeiro</p><h2>Contas dos clientes</h2><span>Saldo atual, vencimentos e pagamentos em um só lugar.</span></div><span className="finance-period">Saldo atual · todos os períodos</span></header>
    <nav className="finance-tabs workspace-tabs" aria-label="Área financeira"><button type="button" aria-pressed={section === "accounts"} onClick={() => setSection("accounts")}><Wallet size={17} />Contas dos clientes</button><button type="button" aria-pressed={section === "settings"} onClick={() => setSection("settings")}><SlidersHorizontal size={17} />Configurações de cobrança</button></nav>
    {section === "settings" ? <BillingSettings usage={usage} onChange={onChange} /> : <>
    <div className="finance-summary">
      <article><span className="finance-summary-icon"><Wallet size={22} /></span><div><small>Total a receber</small><strong>{money(total)}</strong></div></article>
      <article><span className="finance-summary-icon amber"><AlertTriangle size={22} /></span><div><small>Clientes em atraso</small><strong>{all.filter(client => client.overdue).length}</strong></div></article>
      <article><span className="finance-summary-icon green"><CheckCircle2 size={22} /></span><div><small>Clientes em dia</small><strong>{all.filter(client => !client.overdue).length}</strong></div></article>
    </div>
    <div className="finance-layout">
      <aside className="finance-directory">
        <label className="finance-search"><Search size={18} /><input aria-label="Buscar cliente nos custos" placeholder="Buscar cliente…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="finance-filters" aria-label="Filtrar situação financeira">{["Todos", "Em atraso", "Em aberto", "Quitado", "Bloqueado"].map(label => <button key={label} type="button" aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}</button>)}</div>
        <div className="finance-client-list">{rows.map(client => <button type="button" key={client.clientEmail} className={`finance-client-row ${current?.clientEmail === client.clientEmail ? "selected" : ""}`} onClick={() => { setSelected(client.clientEmail); if (window.innerWidth <= 760) requestAnimationFrame(() => document.querySelector(".finance-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>
          <span className="finance-avatar">{name(client.clientEmail).slice(0, 2).toUpperCase()}</span><span className="finance-client-name"><strong>{name(client.clientEmail)}</strong><small>{client.clientEmail}</small><span className={client.overdue ? "finance-status overdue" : "finance-status"}>{status(client)}</span></span><span className="finance-row-amount">{money(client.amountCents)}<ChevronRight size={15} /></span>
        </button>)}</div>
        {!rows.length ? <p className="finance-empty">Nenhum cliente neste filtro.</p> : null}
      </aside>
      {current ? <ClientFinanceEditor key={current.clientEmail} client={current} usage={usage} onChange={onChange} /> : <article className="finance-detail finance-empty"><Wallet size={32} /><h3>Suas contas aparecem aqui</h3><p>Selecione um cliente para definir saldo e vencimento.</p></article>}
    </div>
    </>}
  </section>;
}

function BillingSettings({ usage, onChange }: { usage: AdminImageUsageSnapshot; onChange: Props["onChange"] }) {
  const cents = usage.billingSettings?.dailyLateFeeCents ?? DAILY_LATE_FEE_CENTS;
  const [value, setValue] = useState(inputMoney(cents));
  const dirty = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { if (!dirty.current) setValue(inputMoney(cents)); }, [cents]);
  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try { const amount = parseMoneyInput(value); if (amount > 100_000) throw new Error("A taxa máxima é R$ 1.000,00 por dia."); const next = await saveBillingSettings(amount); dirty.current = false; onChange(next); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a taxa."); }
    finally { setBusy(false); }
  }
  return <article className="finance-detail billing-settings"><header className="finance-detail-header"><div><p>Configuração geral</p><h3>Taxa por dia de atraso</h3></div><CalendarDays size={24} /></header><div className="finance-editor"><p>Vale para todos os clientes cobrados por data. Começa no dia seguinte ao vencimento e aparece separada do saldo.</p><div className="finance-fields"><label><span>Taxa diária (R$)</span><input aria-label="Taxa diária de atraso" inputMode="decimal" value={value} disabled={busy} onChange={event => { dirty.current = true; setValue(event.target.value); setSaved(false); }} /></label></div><p className="finance-help">Use 0,00 para desativar. Ao salvar, os saldos em atraso são recalculados com essa taxa para todos os dias de atraso. Pagamentos já registrados permanecem quitados.</p>{error ? <p role="alert" className="finance-feedback error">{error}</p> : null}{saved ? <p role="status" className="finance-feedback">Taxa atualizada para todos os clientes.</p> : null}<button type="button" className="button primary finance-save" disabled={busy} onClick={() => void save()}><Save size={17} />{busy ? "Salvando…" : "Salvar taxa diária"}</button></div></article>;
}

function ClientFinanceEditor({ client, usage, onChange }: { client: ImageUsageClientSummary; usage: AdminImageUsageSnapshot; onChange: Props["onChange"] }) {
  const dailyLateFeeCents = usage.billingSettings?.dailyLateFeeCents ?? DAILY_LATE_FEE_CENTS;
  const [tab, setTab] = useState("balance");
  const [historyLimit, setHistoryLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const dirty = useRef(new Set<string>());
  const values = () => ({ balance: inputMoney(client.principalCents ?? client.amountCents), dueDate: client.configuredDueDate || "", price: inputMoney(client.routePriceCents), prepaid: String(client.prepaidRoutesRemaining), cadence: String(client.paymentEveryRoutes) });
  const [form, setForm] = useState(values);
  useEffect(() => {
    const next = values();
    setForm(current => Object.fromEntries(Object.entries(next).map(([key, value]) => [key, dirty.current.has(key) ? current[key] : value])) as typeof next);
  }, [client.clientEmail, client.principalCents, client.amountCents, client.configuredDueDate, client.routePriceCents, client.prepaidRoutesRemaining, client.paymentEveryRoutes]);
  const edit = (field: keyof typeof form, value: string) => { dirty.current.add(field); setForm(current => ({ ...current, [field]: value })); setFeedback(""); setError(""); };
  let preview: { principal: number; fee: number; days: number } | undefined;
  try {
    if (isBillingDate(form.dueDate)) {
      const principal = parseMoneyInput(form.balance);
      const days = getBillingDeadline(15, new Date(), undefined, undefined, form.dueDate).daysOverdue;
      preview = { principal, fee: principal > 0 ? days * dailyLateFeeCents : 0, days };
    }
  } catch { /* The form reports invalid values when saving. */ }
  async function save(section: "balance" | "rules") {
    setError(""); setFeedback("");
    try {
      const patch: ClientFinanceSettings = {};
      const fields = section === "balance" ? ["balance", "dueDate"] : ["price", "prepaid", "cadence"];
      if (!fields.some(field => dirty.current.has(field))) { setFeedback("Nenhuma alteração para salvar."); return; }
      if (section === "balance") {
        if (dirty.current.has("balance")) patch.balanceCents = parseMoneyInput(form.balance);
        if (dirty.current.has("dueDate")) patch.dueDate = form.dueDate || null;
        if ((patch.balanceCents ?? client.principalCents ?? client.amountCents) > 0 && !form.dueDate) throw new Error("Escolha uma data de vencimento para esse saldo.");
        if (!client.configuredDueDate && form.dueDate) patch.dueDate = form.dueDate;
      } else {
        if (dirty.current.has("price")) patch.routePriceCents = parseMoneyInput(form.price);
        for (const field of ["prepaid", "cadence"] as const) if (dirty.current.has(field)) {
          if (!/^\d+$/.test(form[field])) throw new Error("Informe uma quantidade inteira, entre 0 e 10000.");
          patch[field === "prepaid" ? "prepaidRoutesRemaining" : "paymentEveryRoutes"] = Number(form[field]);
        }
      }
      setBusy(true);
      const next = await saveClientFinance(client.clientEmail, patch);
      fields.forEach(field => dirty.current.delete(field));
      onChange(next); setFeedback("Alterações salvas. O saldo do cliente já foi atualizado.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  async function pay() {
    if (!window.confirm(`Confirmar o recebimento de ${money(client.amountCents)} de ${client.clientEmail}? O saldo e a taxa atual serão quitados.`)) return;
    setBusy(true); setError(""); setFeedback("");
    try { const next = await registerClientPayment(client.clientEmail); dirty.current.clear(); onChange(next); setFeedback("Pagamento registrado. Defina a próxima data quando combinar um novo prazo."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar o pagamento."); }
    finally { setBusy(false); }
  }
  async function resetPrepaid() {
    if (!window.confirm(`Zerar as rotas antecipadas de ${client.clientEmail}?`)) return;
    setBusy(true); setError("");
    try { const next = await saveClientFinance(client.clientEmail, { prepaidRoutesRemaining: 0 }); dirty.current.delete("prepaid"); onChange(next); setFeedback("Rotas antecipadas zeradas."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível zerar as antecipações."); }
    finally { setBusy(false); }
  }
  async function togglePaymentBlock() {
    const blocked = !client.paymentBlocked;
    if (!window.confirm(blocked ? `Bloquear o uso do bot de ${client.clientEmail} por atraso? O monitoramento será parado e o acesso ao aviso de pagamento será mantido.` : `Desbloquear o bot de ${client.clientEmail}?`)) return;
    setBusy(true); setError(""); setFeedback("");
    try { const next = await saveClientFinance(client.clientEmail, { paymentBlocked: blocked }); onChange(next); setFeedback(blocked ? "Uso do bot bloqueado por atraso. O cliente ainda pode consultar o aviso e o Pix." : "Uso do bot liberado. O cliente pode conectar e armar novamente."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar o bloqueio."); }
    finally { setBusy(false); }
  }
  const events = (usage.financeEvents || []).filter(event => event.clientEmail === client.clientEmail).map(event => ({
    id: event.id, at: event.createdAt, label: event.type === "payment" ? "Pagamento recebido" : event.type === "balance" ? "Saldo ajustado manualmente" : event.type === "deadline" ? "Vencimento atualizado" : event.type === "blocked" ? "Bot bloqueado por atraso" : event.type === "unblocked" ? "Bloqueio financeiro removido" : "Regras de rotas atualizadas",
    detail: event.type === "deadline" ? date(event.dueDate) : event.performedBy, amount: event.amountCents
  }));
  const history = [...events, ...(usage.ledgerEntries || usage.entries).filter(entry => entry.clientEmail === client.clientEmail && (entry.decision === "billable" || entry.cancellation)).map(entry => ({
    id: entry.id, at: entry.cancellation?.cancelledAt || entry.reviewedAt || entry.createdAt, label: entry.cancellation ? "Rota apagada · cobrança cancelada" : `Rota ${entry.gaiola || entry.route || "validada"}`,
    detail: entry.cancellation ? "Consumo cancelado" : entry.paymentStatus === "paid" ? "Pago" : entry.paymentStatus === "prepaid" ? "Antecipação utilizada" : "Em aberto", amount: entry.cancellation ? 0 : entry.amountCents
  }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <article className="finance-detail">
    <header className="finance-detail-header"><div><p>Conta do cliente</p><h3>{name(client.clientEmail)}</h3><small>{client.clientEmail}</small></div><span className={client.overdue ? "finance-status overdue" : "finance-status"}>{status(client)}</span></header>
    <div className="finance-balance-card"><span>Total em aberto</span><strong>{money(client.amountCents)}</strong><div><span>Saldo combinado <b>{money(client.principalCents ?? client.amountCents)}</b></span><span>Taxa de atraso <b>{money(client.lateFeeCents)}</b></span></div><small><CalendarDays size={14} />{client.configuredDueDate ? `Vencimento: ${date(client.configuredDueDate)}` : client.paymentEveryRoutes > 0 ? `Acerto a cada ${client.paymentEveryRoutes} rotas` : client.configuredDueDate === null ? "Defina o próximo vencimento" : `Regra anterior: dia ${client.dueDay} · escolha uma data abaixo`}</small></div>
    <nav className="finance-tabs" aria-label="Detalhes financeiros">
      {[{ id: "balance", title: "Saldo e vencimento", Icon: Wallet }, { id: "rules", title: "Regras de rotas", Icon: SlidersHorizontal }, { id: "history", title: "Histórico", Icon: History }].map(({ id, title, Icon }) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={16} />{title}</button>)}
    </nav>
    {error ? <p className="finance-feedback error" role="alert">{error}</p> : null}{feedback ? <p className="finance-feedback" role="status">{feedback}</p> : null}
    {tab === "balance" ? <div className="finance-editor">
      <div className="finance-section-title"><CircleDollarSign size={20} /><div><h4>Quanto esse cliente precisa pagar?</h4><p>Edite o saldo total do cliente, sem alterar o preço de uma rota.</p></div></div>
      <div className="finance-fields"><label><span>Valor do cliente · sem taxa (R$)</span><input disabled={busy} aria-label="Saldo total do cliente" inputMode="decimal" value={form.balance} onChange={event => edit("balance", event.target.value)} /></label><label><span>Data de vencimento</span><input disabled={busy} aria-label="Data de vencimento do cliente" type="date" value={form.dueDate} onChange={event => edit("dueDate", event.target.value)} /></label></div>
      <p className="finance-help">Esse valor substitui o saldo atual. Novas rotas validadas continuam somando o preço configurado.</p>
      <div className="finance-fee-policy"><AlertTriangle size={18} /><span><strong>{money(dailyLateFeeCents)} por dia de atraso</strong><small>A partir do dia seguinte à data escolhida. Edite o valor em Configurações de cobrança.</small></span></div>
      {preview ? <div className="finance-preview" role="status"><small>Prévia com o valor e a data escolhidos</small><span>Saldo {money(preview.principal)} + taxa de {preview.days} dia(s): {money(preview.fee)}</span><strong>Total: {money(preview.principal + preview.fee)}</strong></div> : null}
      <button className="button primary finance-save" type="button" disabled={busy} onClick={() => void save("balance")}><Save size={17} />{busy ? "Salvando…" : "Salvar saldo e vencimento"}</button>
      <div className="finance-payment-section"><div><h4>Recebeu o pagamento?</h4><p>Confirme aqui depois de conferir o recebimento no seu banco.</p></div><button type="button" className="button" disabled={busy || client.amountCents <= 0} onClick={() => void pay()}><CheckCircle2 size={17} />Registrar pagamento</button></div>
      <div className="finance-payment-section finance-access-section"><div><h4>Acesso ao bot</h4><p>{client.paymentBlocked ? "Bloqueado por atraso. O cliente pode entrar para consultar o Pix. Registrar o pagamento remove este bloqueio." : "Você decide quando bloquear um cliente em atraso. A conta continua acessível para consultar o pagamento."}</p></div><button type="button" className={`button ${client.paymentBlocked ? "" : "danger"}`} disabled={busy || (!client.paymentBlocked && !client.overdue)} onClick={() => void togglePaymentBlock()}>{client.paymentBlocked ? "Desbloquear por pagamento" : "Bloquear por atraso"}</button></div>
    </div> : null}
    {tab === "rules" ? <div className="finance-editor"><div className="finance-section-title"><SlidersHorizontal size={20} /><div><h4>Regras para as próximas rotas</h4><p>Target, manual e imagem seguem o preço definido aqui.</p></div></div>
      <div className="finance-fields"><label><span>Preço por rota (R$)</span><input disabled={busy} aria-label="Preço por rota" inputMode="decimal" value={form.price} onChange={event => edit("price", event.target.value)} /></label><label><span>Rotas antecipadas restantes</span><input disabled={busy} aria-label="Rotas antecipadas restantes" inputMode="numeric" value={form.prepaid} onChange={event => edit("prepaid", event.target.value)} /></label><label><span>Acerto a cada N rotas · opcional</span><input disabled={busy} aria-label="Quantidade de rotas por acerto" inputMode="numeric" value={form.cadence} onChange={event => edit("cadence", event.target.value)} /></label></div>
      <p className="finance-help">Quantidade 0 usa vencimento por data. Um ciclo por quantidade substitui a data e não gera taxa diária. Salvar uma data na outra aba ativa o prazo por calendário.</p>
      {client.creditBalanceCents ? <p className="finance-help">Crédito de rotas canceladas: {money(client.creditBalanceCents)}</p> : null}
      <button className="button primary finance-save" type="button" disabled={busy} onClick={() => void save("rules")}><Save size={17} />Salvar regras de rotas</button>
      <button className="button finance-reset-prepaid" type="button" disabled={busy || client.prepaidRoutesRemaining === 0} onClick={() => void resetPrepaid()}>Zerar antecipações</button>
    </div> : null}
    {tab === "history" ? <div className="finance-history">{history.slice(0, historyLimit).map(event => <div key={event.id}><span><strong>{event.label}</strong><small>{date(event.at)} · {event.detail}</small></span>{event.amount !== undefined ? <b>{money(event.amount)}</b> : null}</div>)}{!history.length ? <p className="finance-empty">Nenhum lançamento para este cliente.</p> : null}{history.length > historyLimit ? <button type="button" className="button" onClick={() => setHistoryLimit(limit => limit + 50)}>Ver mais lançamentos</button> : null}</div> : null}
  </article>;
}
