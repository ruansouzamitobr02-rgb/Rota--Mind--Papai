const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
if (!process.env.DESKTOP_AUDIT_DATA_DIR) throw new Error("Use run-desktop-audit.cjs audit-deleted-routes.cjs");
app.setPath("userData", process.env.DESKTOP_AUDIT_DATA_DIR);
const rendererDir = path.resolve(__dirname, "../dist/desktop/renderer");
const streams = new Set();
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1).toISOString();
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString();
const old = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString();
const clients = ["alpha@test.com", "beta@test.com"];
function route(id, email, createdAt, deletedAt, actor) {
  return { id, clientEmail: email, groupJid: "group@g.us", groupName: "Grupo de rotas", mode: "target", trigger: "automatic",
    messages: [`Mensagem ${id}`], sentMessageIds: [`msg-${id}`], createdAt, updatedAt: deletedAt || createdAt,
    confirmedCount: 1, totalCount: 1, status: "sent", reactions: [], validated: !deletedAt,
    decisionStatus: deletedAt ? "deleted" : "validated", ...(deletedAt ? { deletedAt, deletedMessageIds: [`msg-${id}`],
      deletionEvents: [{ messageId: `msg-${id}`, detectedAt: deletedAt, actor, source: "update" }],
      validationBeforeDeletion: { validatedAt: createdAt, validatedBy: "Líder anterior" } } : {}) };
}
const monitor = {
  routes: { routes: [route("antiga-apagada-hoje", clients[0], old, today, "client"), route("apagada-ontem", clients[0], today, yesterday, "unknown"),
    route("outro-participante", clients[1], today, today, "other"), route("valida", clients[0], today)],
    pendingReactionRoutes: [], totals: { routes: 4, validated: 1, deleted: 3, reactions: 0, clients: 2 } },
  users: { users: clients.map((email) => ({ email, role: "client", botStatus: "disconnected", presenceStatus: "offline", monitoringEnabled: false, sessionUsageMs: 0 })) },
  support: { messages: [], unread: 0 }, logs: [], leaders: [],
  imageUsage: { month: now.toISOString().slice(0, 7), entries: [], clients: [], totals: { total: 0, pending: 0, billable: 0, excluded: 0, detected: 0, amountCents: 0, unpaidRoutes: 0 } }
};
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const json = (data) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  if (pathname === "/api/me") return json({ email: "admin@test.com", role: "admin" });
  if (pathname === "/api/release") return json({ shouldShow: false });
  if (pathname === "/api/admin/monitor") return json(monitor);
  if (pathname === "/api/admin/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify(monitor)}\n\n`);
    streams.add(response); request.on("close", () => streams.delete(response)); return;
  }
  if (pathname.startsWith("/api/")) return json({ objects: [] });
  const target = path.resolve(rendererDir, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!target.startsWith(rendererDir + path.sep) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(response);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(window, expression, message) {
  for (let i = 0; i < 100; i++) { if (await window.webContents.executeJavaScript(expression)) return; await delay(40); }
  throw new Error(message);
}
const deadline = setTimeout(() => { console.error("Deleted routes audit timed out"); app.exit(1); }, 40_000);
(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (code) => window.webContents.executeJavaScript(code);
  await window.loadURL(base);
  await js("localStorage.setItem('panelToken','audit-token');localStorage.setItem('panelUserRole','admin');localStorage.setItem('panelUserEmail','admin@test.com');");
  await window.loadURL(base + "/?admin=deleted_routes");
  await waitFor(window, "document.querySelector('.adminx-topbar h1')?.textContent === 'Rotas apagadas'", "Aba não abriu");
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 3", "Exclusões não carregaram");
  const setGlobal = (index, value) => js(`{const e=document.querySelectorAll('.adminx-global-filters select')[${index}];e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await setGlobal(1, "today");
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 2", "Hoje não usou a data da exclusão");
  assert.ok((await js("document.querySelector('.adminx-table').textContent")).includes("antiga-apagada-hoje"));
  await setGlobal(0, clients[0]);
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 1", "Filtro de cliente incorreto");
  await js("document.querySelector('.adminx-row-actions button').click()");
  await waitFor(window, "document.querySelector('.adminx-sidepanel')?.textContent.includes('Líder anterior')", "Auditoria perdeu validação anterior");
  assert.equal(await js("!!document.querySelector('.adminx-sidepanel footer')"), false, "Exclusão não pode ser revalidada");
  await js("document.querySelector('.adminx-sidepanel button[title=Fechar]').click()");
  await setGlobal(1, "all");
  await js("{const e=document.querySelector('select[aria-label=\"Quem apagou\"]'); e.value='unknown';e.dispatchEvent(new Event('change',{bubbles:true}));}");
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 1 && document.querySelector('.adminx-table').textContent.includes('apagada-ontem')", "Filtro de autoria incorreto");
  await js("{const e=document.querySelector('select[aria-label=\"Quem apagou\"]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}));}");
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 2", "Filtro de autoria não limpou");
  await js("window.__csv=''; const original=URL.createObjectURL;URL.createObjectURL=function(blob){blob.text().then(text=>window.__csv=text);return original.call(this,blob)};HTMLAnchorElement.prototype.click=function(){};[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Exportar apagadas')).click();");
  await waitFor(window, "window.__csv.includes('apagada_em') && window.__csv.includes('Líder anterior')", "CSV perdeu os dados da exclusão");
  await js("[...document.querySelectorAll('.adminx-sidebar nav button')].find(b=>b.textContent.includes('Rotas validadas')).click()");
  await waitFor(window, "document.querySelectorAll('.adminx-table tbody tr').length === 1", "Apagadas apareceram nas validadas");
  console.log("PASS: apagadas têm filtros de data, cliente e autoria, auditoria anterior e CSV; não entram nas validadas.");
  await js("document.querySelector('.adminx-row-actions button').click()");
  await waitFor(window, "Boolean(document.querySelector('.adminx-sidepanel footer'))", "Detalhe da rota válida não abriu");
  monitor.routes.routes[3] = route("valida", clients[0], today, today, "client");
  for (const stream of streams) stream.write(`data: ${JSON.stringify(monitor)}\n\n`);
  await waitFor(window, "document.querySelector('.adminx-sidepanel')?.textContent.includes('Exclusão da mensagem') && !document.querySelector('.adminx-sidepanel footer')", "Detalhe aberto manteve validação após exclusão");
  assert.equal(await js("document.querySelectorAll('.adminx-table .adminx-row-actions').length"), 0);
  console.log("PASS: exclusão recebida ao vivo remove a rota das validadas e atualiza o detalhe já aberto.");
  await js("document.querySelector('.adminx-sidepanel button[title=Fechar]').click();[...document.querySelectorAll('.adminx-sidebar nav button')].find(b=>b.textContent.includes('Relatórios')).click()");
  await waitFor(window, "[...document.querySelectorAll('th')].some(th=>th.textContent==='Apagadas')", "Relatório sem coluna de apagadas");
  window.setSize(390, 844);
  await js("[...document.querySelectorAll('.adminx-sidebar nav button')].find(b=>b.textContent.includes('Rotas apagadas')).click()");
  await waitFor(window, "document.querySelector('.adminx-topbar h1')?.textContent==='Rotas apagadas' && document.querySelectorAll('.adminx-table tbody tr').length === 3", "Aba móvel não respondeu");
  console.log("PASS: relatórios exibem apagadas e a aba responde no tamanho de celular.");
  window.destroy(); for (const stream of streams) stream.end(); server.close(); clearTimeout(deadline); app.quit();
})().catch((error) => { console.error(error.stack || error); clearTimeout(deadline); app.exit(1); });
