const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const root = process.env.DESKTOP_AUDIT_DATA_DIR;
if (!root) throw new Error("Use run-desktop-audit.cjs audit-costs.cjs");
app.setPath("userData", root);
const store = new ImageUsageStore(path.join(root, "usage.json"));
const email = "guilherme@test.com", emails = [email, "fernando@test.com"];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
store.setRoutePrice(email, 500);
store.updateClientFinance(email, { balanceCents: 5000, dueDate: yesterday }, "admin@test.com");
store.updateClientFinance(emails[1], { balanceCents: 2000 }, "admin@test.com");
const streams = new Set(), renderer = path.resolve(__dirname, "../dist/desktop/renderer");
function monitor() { return { users: { users: emails.map(email => ({ email, role: "client", botStatus: "disconnected", presenceStatus: "offline", sessionUsageMs: 0, monitoringEnabled: false })) },
  routes: { routes: [], pendingReactionRoutes: [], totals: { routes: 0, validated: 0, clients: 2, reactions: 0 } }, support: { messages: [], unread: 0 }, logs: [], leaders: [], imageUsage: store.snapshot() }; }
function broadcast() { for (const stream of streams) stream.write(`data: ${JSON.stringify(monitor())}\n\n`); }
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const json = data => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  if (pathname === "/api/me") return json({ email: "admin@test.com", role: "admin" });
  if (pathname === "/api/release") return json({ shouldShow: false });
  if (pathname === "/api/admin/monitor") return json(monitor());
  if (pathname === "/api/admin/events") { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); streams.add(response); response.write(`data: ${JSON.stringify(monitor())}\n\n`); request.on("close", () => streams.delete(response)); return; }
  if (pathname === "/api/admin/billing-settings") { let body = ""; for await (const chunk of request) body += chunk; store.updateBillingSettings(JSON.parse(body).dailyLateFeeCents, "admin@test.com"); json(store.snapshot()); broadcast(); return; }
  if (pathname.startsWith("/api/admin/client-finance/")) {
    let body = ""; for await (const chunk of request) body += chunk;
    store.updateClientFinance(decodeURIComponent(pathname.split("/").at(-1)), JSON.parse(body), "admin@test.com");
    json(store.snapshot()); broadcast(); return;
  }
  if (pathname.startsWith("/api/admin/client-payment/")) { store.registerPayment(decodeURIComponent(pathname.split("/").at(-1)), "admin@test.com"); json(store.snapshot()); broadcast(); return; }
  if (pathname.startsWith("/api/")) return json({ objects: [] });
  const file = path.resolve(renderer, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(response);
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(window, expression, message) { for (let n = 0; n < 100; n++) { if (await window.webContents.executeJavaScript(expression)) return; await wait(40); } throw new Error(message); }
const deadline = setTimeout(() => { console.error("Costs audit timed out"); app.exit(1); }, 35000);
(async () => {
  await app.whenReady(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = source => window.webContents.executeJavaScript(source);
  await window.loadURL(base); await js("localStorage.setItem('panelToken','costs-token');localStorage.setItem('panelUserRole','admin');localStorage.setItem('panelUserEmail','admin@test.com');");
  await window.loadURL(base + "/?admin=costs");
  await until(window, "document.querySelectorAll('.finance-client-row').length===2", "lista de clientes não carregou");
  assert.match(await js("document.querySelector('.finance-detail-header').textContent"), /guilherme/);
  const edit = (label, value) => js(`(()=>{const input=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await edit("Saldo total do cliente", "87,50"); await edit("Data de vencimento do cliente", "2027-01-15");
  broadcast(); await wait(150);
  assert.equal(await js("document.querySelector('input[aria-label=\"Saldo total do cliente\"]').value"), "87,50", "atualização apagou valor sendo editado");
  await js("document.querySelector('.finance-save').click()");
  await until(window, "document.querySelector('.finance-feedback')?.textContent.includes('salvas')", "saldo não foi salvo");
  assert.equal(store.clientSnapshot(email).principalCents, 8750); assert.equal(store.snapshot().clients.find(c => c.clientEmail === email).routePriceCents, 500);
  assert.equal(store.snapshot().clients.find(c => c.clientEmail === email).configuredDueDate, "2027-01-15");
  await edit("Data de vencimento do cliente", yesterday);
  assert.match(await js("document.querySelector('.finance-preview').textContent"), /88,00/);
  await js("document.querySelector('.finance-save').click()");
  await wait(150); assert.equal(store.clientSnapshot(email).lateFeeCents, 50); assert.equal(store.clientSnapshot(email).amountCents, 8800);
  await js("window.confirm=()=>true;document.querySelector('.finance-access-section button').click()"); await wait(150);
  assert.equal(store.isPaymentBlocked(email), true);
  await until(window, "document.querySelector('.finance-access-section button')?.textContent.includes('Desbloquear')", "botão de desbloquear não apareceu");
  await js("document.querySelector('.finance-access-section button').click()"); await wait(150);
  assert.equal(store.isPaymentBlocked(email), false);
  console.log("PASS: saldo manual independente do preço, taxa de R$ 0,50/dia e bloqueio/desbloqueio em Custos.");
  await js("document.querySelectorAll('.finance-detail .finance-tabs button')[1].click()"); await edit("Preço por rota", "6,50"); await js("document.querySelector('.finance-save').click()"); await wait(150);
  assert.equal(store.snapshot().clients.find(c => c.clientEmail === email).routePriceCents, 650); assert.equal(store.clientSnapshot(email).principalCents, 8750);
  await js("document.querySelectorAll('.finance-detail .finance-tabs button')[2].click()");
  await until(window, "document.querySelector('.finance-history')?.textContent.includes('Saldo ajustado manualmente')", "auditoria não apareceu");
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/costs-desktop.png"), (await window.webContents.capturePage()).toPNG());
  window.setSize(390, 844);
  await until(window, "innerWidth < 500", "viewport móvel não foi aplicado");
  await js("document.querySelectorAll('.finance-detail .finance-tabs button')[0].click();document.querySelector('.finance-detail').scrollIntoView({behavior:'instant',block:'start'});");
  await until(window, "document.querySelector('.finance-detail').getBoundingClientRect().top < 120", "editor não ficou acessível ao rolar a tela móvel");
  await wait(250);
  const bounds = await js("(()=>{const r=document.querySelector('.finance-detail').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()");
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "editor ultrapassou tela do celular");
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/costs-mobile.png"), (await window.webContents.capturePage()).toPNG());
  store.updateClientFinance(email, { paymentBlocked: true }); broadcast(); await wait(100);
  await js("window.confirm=()=>true;document.querySelector('.finance-payment-section button').click()"); await wait(150);
  assert.equal(store.clientSnapshot(email).amountCents, 0); assert.equal(store.snapshot().clients.find(c => c.clientEmail === email).configuredDueDate, null);
  assert.equal(store.isPaymentBlocked(email), false);
  await js("document.querySelectorAll('.workspace-tabs button')[1].click()");
  await edit("Taxa diária de atraso", "0,75");
  await js("document.querySelector('.billing-settings .finance-save').click()");
  await until(window, "document.querySelector('.billing-settings [role=status]')?.textContent.includes('atualizada')", "taxa não foi salva");
  assert.equal(store.snapshot().billingSettings.dailyLateFeeCents, 75);
  assert.equal(store.clientSnapshot(email).amountCents, 0, "taxa reviveu saldo quitado");
  console.log("PASS: aba de configuração salva taxa diária e preserva contas quitadas.");
  console.log("PASS: abas de regras e histórico, layout móvel, pagamento quita saldo/taxa e inicia próximo período sem prazo antigo.");
  window.destroy(); for (const stream of streams) stream.end(); server.close(); clearTimeout(deadline); app.quit();
})().catch(error => { console.error(error.stack || error); clearTimeout(deadline); app.exit(1); });
