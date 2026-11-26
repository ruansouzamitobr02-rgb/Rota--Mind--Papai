import { useEffect, useRef, useState } from "react";
import { Ban, Bot, Eye, EyeOff, KeyRound, Pencil, Search, ShieldCheck, Users, Wallet } from "lucide-react";
import { AdminImageUsageSnapshot, AdminUserSummary } from "../../../shared/types";
import { revealAdminUserPassword } from "../api";

type Props = {
  users: AdminUserSummary[]; usage: AdminImageUsageSnapshot; search: string; clientFilter: string;
  onOpen: (email: string) => void; onEdit: (user: AdminUserSummary) => void;
  onToggleBlock: (user: AdminUserSummary) => void; onCosts: (email: string) => void;
};
const money = (cents = 0) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const date = (value?: string) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Ainda não acessou";

export function UsersWorkspace({ users, usage, search, clientFilter, onOpen, onEdit, onToggleBlock, onCosts }: Props) {
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("Todos"), [selected, setSelected] = useState("");
  const accounts = users.filter(user => (clientFilter === "all" || user.email === clientFilter) && [query, search].every(term => user.email.toLowerCase().includes(term.trim().toLowerCase())));
  const isBlocked = (user: AdminUserSummary) => user.blocked || usage.clients.some(client => client.clientEmail === user.email && client.paymentBlocked);
  const rows = accounts.filter(user => filter === "Todos" || (filter === "Bloqueados" ? isBlocked(user) : filter === "Online" ? user.presenceStatus === "online" : filter === "Armados" ? user.monitoringEnabled : user.role === "admin"));
  const user = rows.find(item => item.email === selected) || rows[0];
  return <section className="finance-workspace users-workspace">
    <header className="finance-heading"><div><p>Gestão de acesso</p><h2>Usuários e clientes</h2><span>Selecione uma conta para consultar o acesso, o bot e as prioridades.</span></div></header>
    <div className="finance-summary"><article><span className="finance-summary-icon"><Users size={22} /></span><div><small>Contas</small><strong>{accounts.length}</strong></div></article><article><span className="finance-summary-icon green"><Bot size={22} /></span><div><small>Bots armados</small><strong>{accounts.filter(item => item.monitoringEnabled).length}</strong></div></article><article><span className="finance-summary-icon amber"><Ban size={22} /></span><div><small>Contas bloqueadas</small><strong>{accounts.filter(isBlocked).length}</strong></div></article></div>
    <div className="finance-layout"><aside className="finance-directory">
      <label className="finance-search"><Search size={18} /><input aria-label="Buscar usuário" placeholder="Buscar usuário…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="finance-filters" aria-label="Filtrar usuários">{["Todos", "Online", "Armados", "Bloqueados", "Administradores"].map(label => <button key={label} type="button" aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}</button>)}</div>
      <div className="finance-client-list">{rows.map(item => <button type="button" key={item.email} className={`finance-client-row ${item.email === user?.email ? "selected" : ""}`} onClick={() => { setSelected(item.email); if (innerWidth <= 760) requestAnimationFrame(() => document.querySelector(".users-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}><span className="finance-avatar" style={{ color: item.color }}>{item.email.slice(0, 2).toUpperCase()}</span><span className="finance-client-name"><strong>{item.email.split("@")[0]}</strong><small title={item.email}>{item.email}</small><span className={`finance-status ${isBlocked(item) ? "overdue" : ""}`}>{isBlocked(item) ? "Bloqueado" : item.monitoringEnabled ? "Bot armado" : item.presenceStatus === "online" ? "Online" : "Offline"} · {item.role === "admin" ? "Admin" : "Cliente"}</span></span></button>)}</div>
      {!rows.length ? <p className="finance-empty">Nenhum usuário nesse filtro.</p> : null}
    </aside>{user ? <UserAccount key={user.email} user={user} usage={usage} onOpen={onOpen} onEdit={onEdit} onToggleBlock={onToggleBlock} onCosts={onCosts} /> : <article className="finance-detail finance-empty"><Users size={32} /><h3>Nenhuma conta encontrada</h3><p>Altere os filtros ou adicione um usuário.</p></article>}</div>
  </section>;
}

function UserAccount({ user, usage, onOpen, onEdit, onToggleBlock, onCosts }: Omit<Props, "users" | "search" | "clientFilter"> & { user: AdminUserSummary }) {
  const [tab, setTab] = useState("overview");
  const client = usage.clients.find(item => item.clientEmail === user.email);
  return <article className="finance-detail users-detail"><header className="finance-detail-header"><div><p>{user.role === "admin" ? "Administrador" : "Cliente"}</p><h3>{user.email.split("@")[0]}</h3><small>{user.email}</small></div><button className="button" type="button" onClick={() => onEdit(user)}><Pencil size={16} />Editar</button></header>
    <nav className="finance-tabs" aria-label="Detalhes do usuário">{[{ id: "overview", label: "Visão geral", Icon: Users }, { id: "access", label: "Acesso e senha", Icon: KeyRound }, { id: "priority", label: "Prioridades", Icon: ShieldCheck }].map(({ id, label, Icon }) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</nav>
    {tab === "overview" ? <div className="finance-editor"><div className="workspace-info-grid"><div><small>Painel</small><strong>{user.presenceStatus === "online" ? "Online" : "Offline"}</strong></div><div><small>Bot</small><strong>{user.monitoringEnabled ? "Armado" : user.botStatus === "connected" ? "Conectado" : "Desconectado"}</strong></div><div><small>Último acesso</small><strong>{date(user.lastSeenAt || user.lastLoginAt)}</strong></div><div><small>Tempo de uso</small><strong>{Math.floor(user.totalUsageMs / 3_600_000)}h {Math.floor((user.totalUsageMs % 3_600_000) / 60_000)}min</strong></div></div><div className="workspace-actions"><button type="button" className="button" onClick={() => onOpen(user.email)}>Abrir detalhes do bot</button></div>{user.role === "client" ? <div className="finance-payment-section"><div><h4>Conta do cliente · {money(client?.amountCents)}</h4><p>{client?.paymentBlocked ? "Uso suspenso por pagamento pendente." : client?.overdue ? "Pagamento em atraso." : "Consulte o saldo e o vencimento em Custos."}</p></div><button type="button" className="button" onClick={() => onCosts(user.email)}><Wallet size={16} />Gerenciar custos</button></div> : null}</div> : null}
    {tab === "access" ? <div className="finance-editor"><PasswordAccess email={user.email} /><div className="finance-payment-section"><div><h4>Bloqueio geral da conta</h4><p>{user.blocked ? "O login e o uso da conta estão bloqueados." : "Bloqueia o login e encerra o acesso à conta. Para atraso de pagamento, use o bloqueio em Custos: o cliente verá a tela vermelha com seu Pix."}</p></div><button type="button" className={`button ${user.blocked ? "" : "danger"}`} onClick={() => onToggleBlock(user)}>{user.blocked ? "Liberar conta" : "Bloquear conta"}</button></div></div> : null}
    {tab === "priority" ? <div className="finance-editor"><div className="finance-section-title"><ShieldCheck size={22} /><div><h4>Confrontos entre clientes</h4><p>Regras que decidem quem tem prioridade quando disputam a mesma rota.</p></div></div><div className="workspace-rule-list">{user.dispatchMatchups?.length ? user.dispatchMatchups.map(rule => <div key={rule.opponentEmail}><strong>{rule.outcome === "wins" ? "Ganha de" : "Perde para"} {rule.opponentEmail}</strong><small>Vantagem de {rule.delayMs} ms</small></div>) : <p className="finance-help">Nenhum confronto configurado.</p>}</div><button className="button" type="button" onClick={() => onEdit(user)}>Editar prioridades</button></div> : null}
  </article>;
}

function PasswordAccess({ email }: { email: string }) {
  const [password, setPassword] = useState<string>(), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const active = useRef(true), requestVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    const hide = () => { requestVersion.current++; setPassword(undefined); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("blur", hide);
    return () => { active.current = false; requestVersion.current++; document.removeEventListener("visibilitychange", visibility); window.removeEventListener("blur", hide); };
  }, []);
  useEffect(() => { if (password === undefined) return; const timer = setTimeout(() => setPassword(undefined), 30_000); return () => clearTimeout(timer); }, [password]);
  async function reveal() {
    if (password !== undefined) { setPassword(undefined); return; }
    const version = ++requestVersion.current;
    setBusy(true); setMessage("");
    try { const next = await revealAdminUserPassword(email); if (active.current && version === requestVersion.current) { setPassword(next.password); setMessage(next.available ? "Visível por 30 segundos, somente para você." : next.reason || "Senha indisponível. Defina uma nova em Editar."); } }
    catch (cause) { if (active.current && version === requestVersion.current) setMessage(cause instanceof Error ? cause.message : "Não foi possível consultar a senha."); }
    finally { if (active.current) setBusy(false); }
  }
  return <section className="workspace-password"><div className="finance-section-title"><KeyRound size={22} /><div><h4>Senha de acesso</h4><p>A consulta é restrita ao administrador e fica registrada.</p></div></div><div className="workspace-secret" aria-label="Senha do usuário">{password ?? "••••••••••••"}</div><button type="button" className="button" disabled={busy} onClick={() => void reveal()}>{password === undefined ? <Eye size={17} /> : <EyeOff size={17} />}{busy ? "Consultando…" : password === undefined ? "Visualizar senha" : "Ocultar senha"}</button>{message ? <p className="finance-help" role="status">{message}</p> : null}</section>;
}
