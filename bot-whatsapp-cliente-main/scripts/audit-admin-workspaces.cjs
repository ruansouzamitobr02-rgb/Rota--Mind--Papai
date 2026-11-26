const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const root = process.env.DESKTOP_AUDIT_DATA_DIR;
if (!root) throw new Error("Use run-desktop-audit.cjs audit-admin-workspaces.cjs");
app.setPath("userData", root);
const store = new ImageUsageStore(path.join(root, "usage.json"));
const client = "cliente@workspace.test", blocked = "blocked@workspace.test";
store.updateClientFinance(client, { balanceCents: 5000, dueDate: "2099-01-01" });
let users = ["admin@workspace.test", client, blocked].map((email, index) => ({ email, role: index === 0 ? "admin" : "client", blocked: index === 2, color: "#ab78de", presenceStatus: index === 1 ? "online" : "offline", monitoringEnabled: false, botStatus: "disconnected", totalUsageMs: 7200000, dispatchMatchups: index === 1 ? [{ opponentEmail: blocked, outcome: "wins", delayMs: 400 }] : [], lastSeenAt: "2026-11-25T12:00:00Z" }));
let messages = [{ id: "one", email: client, message: "Preciso conferir meu vencimento", createdAt: new Date().toISOString(), read: false }, { id: "two", email: blocked, message: "Mensagem antiga", createdAt: new Date().toISOString(), read: true }];
let revealRequests = 0, editRequests = 0;
const secret = "Browser-fixture-Only!";
const streams = new Set(), renderer = path.resolve(__dirname, "../dist/desktop/renderer");
const monitor = () => ({ users: { users }, routes: { routes: [], totals: { routes: 0, validated: 0, clients: 2, reactions: 0 } }, support: { messages, unread: messages.filter(message => !message.read).length }, logs: [{ id: "err", clientEmail: client, level: "error", message: "Fixture error", timestamp: new Date().toISOString() }], leaders: [], imageUsage: store.snapshot() });
function broadcast() { for (const stream of streams) stream.write(`data: ${JSON.stringify(monitor())}\n\n`); }
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const json = data => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  if (pathname === "/api/me") return json({ email: users[0].email, role: "admin" });
  if (pathname === "/api/release") return json({ shouldShow: false });
  if (pathname === "/api/admin/monitor") return json(monitor());
  if (pathname === "/api/admin/events") { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); streams.add(response); response.write(`data: ${JSON.stringify(monitor())}\n\n`); request.on("close", () => streams.delete(response)); return; }
  if (pathname.endsWith("/password/reveal")) { assert.equal(request.headers["x-panel-token"], "workspace-token"); revealRequests++; return json({ available: true, password: secret }); }
  if (pathname.startsWith("/api/admin/users/") && request.method === "PATCH") { let body = ""; for await (const chunk of request) body += chunk; const update = JSON.parse(body); const email = decodeURIComponent(pathname.split("/").at(-1)); users = users.map(user => user.email === email ? { ...user, ...update, password: undefined } : user); editRequests++; json({ users }); broadcast(); return; }
  if (pathname.startsWith("/api/admin/support/messages/")) { const id = pathname.split("/").at(-1); messages = messages.map(message => message.id === id ? { ...message, read: true } : message); json({ messages, unread: messages.filter(message => !message.read).length }); broadcast(); return; }
  if (pathname.startsWith("/api/")) return json({ objects: [] });
  const file = path.resolve(renderer, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(response);
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(window, source, message) { for (let i = 0; i < 120; i++) { if (await window.webContents.executeJavaScript(source)) return; await wait(30); } throw new Error(message); }
(async () => {
  await app.whenReady(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", event => { if (event.level === "error") console.error("Renderer:", event.message); });
  const js = async source => { try { return await window.webContents.executeJavaScript(source); } catch (error) { console.error("Failed browser action:", source); throw error; } };
  await window.loadURL(base); await js("localStorage.setItem('panelToken','workspace-token');localStorage.setItem('panelUserRole','admin');localStorage.setItem('panelUserEmail','admin@workspace.test');");
  await window.loadURL(base + "/?admin=clients");
  await until(window, "document.querySelectorAll('.users-workspace .finance-client-row').length===3", "usuários não carregaram");
  await js("[...document.querySelectorAll('.finance-filters button')].find(b=>b.textContent==='Bloqueados').click()");
  await until(window, "document.querySelectorAll('.finance-client-row').length===1", "filtro de bloqueados falhou");
  assert.match(await js("document.querySelector('.finance-client-row').textContent"), /blocked/);
  await js("[...document.querySelectorAll('.finance-filters button')].find(b=>b.textContent==='Todos').click()");
  await js("[...document.querySelectorAll('.finance-client-row')].find(b=>b.textContent.includes('cliente@')).click()");
  await until(window, "document.querySelector('.users-detail .finance-detail-header').textContent.includes('cliente@')", "seleção de cliente falhou");
  await js("document.querySelectorAll('.users-detail .finance-tabs button')[1].click()");
  assert.equal(revealRequests, 0);
  await js("document.querySelector('.workspace-password > button').click()");
  await until(window, `document.querySelector('.workspace-secret')?.textContent===${JSON.stringify(secret)}`, "senha não apareceu");
  assert.equal(revealRequests, 1);
  await js("window.dispatchEvent(new Event('blur'))");
  await until(window, `!document.body.textContent.includes(${JSON.stringify(secret)})`, "senha não foi ocultada ao sair");
  await js("document.querySelector('.workspace-password > button').click()");
  await until(window, `document.querySelector('.workspace-secret')?.textContent===${JSON.stringify(secret)}`, "segunda consulta falhou");
  await js("document.querySelector('.workspace-password > button').click()");
  assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(secret)})`), false);
  await js("document.querySelectorAll('.users-detail .finance-tabs button')[2].click()");
  assert.match(await js("document.querySelector('.workspace-rule-list').textContent"), /Ganha de blocked/);
  await js("document.querySelector('.users-detail .finance-detail-header button').click()");
  await until(window, "Boolean(document.querySelector('.user-editor-dialog'))", "editor não abriu");
  const edit = (selector, value) => js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await edit(".user-editor-dialog input[type=password]", "New-browser-fixture!");
  assert.equal(await js("document.activeElement.type"), "email", "editor perdeu o foco de forma inesperada");
  await js("document.querySelector('.user-editor-dialog form').requestSubmit()");
  await until(window, "!document.querySelector('.user-editor-dialog')", "editor não salvou"); assert.equal(editRequests, 1);
  await wait(250);
  fs.mkdirSync(path.resolve(__dirname, "../.audit-artifacts"), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/users-desktop.png"), (await window.webContents.capturePage()).toPNG());
  window.setSize(390, 844); await until(window, "innerWidth < 500", "viewport móvel não abriu");
  await js("document.querySelector('.users-detail').scrollIntoView({behavior:'instant',block:'start'})");
  const bounds = await js("(()=>{const r=document.querySelector('.users-detail').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()");
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "usuários ultrapassaram a tela móvel");
  await wait(250);
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/users-mobile.png"), (await window.webContents.capturePage()).toPNG());
  console.log("PASS: usuários filtráveis, senha só sob consulta e oculta ao sair, prioridades, edição e layout móvel.");
  await window.loadURL(base + "/?admin=support");
  await until(window, "document.querySelectorAll('.support-workspace .finance-client-row').length===2", "suporte não agrupou clientes");
  await js("[...document.querySelectorAll('.finance-filters button')].find(b=>b.textContent==='Não lidas').click()");
  await until(window, "document.querySelectorAll('.finance-client-row').length===1", "suporte não filtrou não lidas");
  await js("document.querySelector('.workspace-messages article button').click()");
  await until(window, "document.querySelectorAll('.finance-client-row').length===0", "marcar lida não atualizou fila");
  assert.equal(messages[0].read, true);
  console.log("PASS: suporte agrupado por cliente e fila de não lidas atualizada após leitura.");
  window.destroy(); for (const stream of streams) stream.end(); server.close(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
