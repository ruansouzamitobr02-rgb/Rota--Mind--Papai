const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { DEFAULT_CONFIG } = require("../dist/bot/config");
if (!process.env.DESKTOP_AUDIT_DATA_DIR) throw new Error("Use run-desktop-audit.cjs audit-client-debt.cjs");
app.setPath("userData", process.env.DESKTOP_AUDIT_DATA_DIR);
const renderer = path.resolve(__dirname, "../dist/desktop/renderer");
const streams = new Set();
let billingRequests = 0;
let pendingResponse;
let holdResponse = false;
let finance = { month: "2026-11", amountCents: 7500, principalCents: 7000, lateFeeCents: 500, dailyLateFeeCents: 50, unpaidRoutes: 15, dueDay: 15,
  dueDate: "2026-11-15T23:59:59.999-03:00", daysOverdue: 10, overdue: true, paymentEveryRoutes: 0,
  billingNotice: { key: "overdue-fixture", day: "2026-11-25", phase: "overdue", dismissedToday: false } };
const snapshot = { status: "connected", groupState: "closed", qrCode: "", config: { ...DEFAULT_CONFIG, nomeEnvio: "Cliente", grupoAlvoJid: "test@g.us" },
  monitoringEnabled: false, groups: [], logs: [], readinessChecks: [], routeDispatches: [], statusEvents: [], imageUsage: finance };
function broadcast() { snapshot.imageUsage = finance; for (const stream of streams) stream.write(`data: ${JSON.stringify(snapshot)}\n\n`); }
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const json = data => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  if (pathname === "/api/me") return json({ email: "guilherme@test.com", role: "client" });
  if (pathname === "/api/release") return json({ shouldShow: false });
  if (pathname === "/api/snapshot") return json(snapshot);
  if (pathname === "/api/billing/status") {
    assert.equal(request.headers["x-panel-token"], "debt-test-token");
    billingRequests++;
    if (holdResponse) { pendingResponse = () => json({ ...finance, overdue: true, amountCents: 7500 }); return; }
    return json(finance);
  }
  if (pathname === "/api/billing/dismiss") { finance = { ...finance, billingNotice: { ...finance.billingNotice, dismissedToday: true } }; return json(finance); }
  if (pathname === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    streams.add(response); request.on("close", () => streams.delete(response)); return;
  }
  const file = path.resolve(renderer, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(window, expression, message) {
  for (let i = 0; i < 120; i++) { if (await window.webContents.executeJavaScript(expression)) return; await delay(30); }
  throw new Error(message);
}
const deadline = setTimeout(() => { console.error("Client debt audit timed out"); app.exit(1); }, 35_000);
(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false, offscreen: true } });
  const js = code => window.webContents.executeJavaScript(code);
  await window.loadURL(base);
  await js("localStorage.setItem('panelToken','debt-test-token');localStorage.setItem('panelUserRole','client');localStorage.setItem('panelUserEmail','guilherme@test.com');");
  await window.loadURL(base);
  await waitFor(window, "Boolean(document.querySelector('.client-debt-dialog'))", "aviso de débito não abriu");
  assert.match(await js("document.querySelector('.client-debt-amount').textContent"), /75,00/);
  assert.match(await js("document.querySelector('.client-debt-fee-warning').textContent"), /0,50/);
  assert.match(await js("document.querySelector('.client-debt-breakdown').textContent"), /70,00/);
  assert.match(await js("document.querySelector('.client-debt-pix').textContent"), /91980984781/);
  assert.match(await js("document.querySelector('.client-debt-pix').textContent"), /Ruan Souza da Silva/);
  const bounds = await js("(()=>{const r=document.querySelector('.client-debt-dialog').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()");
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "aviso ultrapassou a tela do celular");
  await delay(500);
  assert.equal(await js("getComputedStyle(document.querySelector('.client-debt-dialog')).opacity"), "1");
  assert.equal(await js("Boolean(document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.client-debt-dialog'))"), true, "o aviso deve ficar visível acima do conteúdo");
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/client-debt-mobile.png"), (await window.webContents.capturePage()).toPNG());
  await js("document.querySelector('.client-debt-close').click()");
  await waitFor(window, "!document.querySelector('.client-debt-dialog') && Boolean(document.querySelector('.client-debt-frame'))", "fechar deveria manter somente a indicação de atraso");
  broadcast(); await delay(150);
  assert.equal(await js("Boolean(document.querySelector('.client-debt-dialog'))"), false, "atualização não pode desfazer o adiamento");
  await window.reload();
  await waitFor(window, "Boolean(document.querySelector('.client-debt-banner'))", "conta não reabriu");
  assert.equal(await js("Boolean(document.querySelector('.client-debt-dialog'))"), false, "reabrir no mesmo dia não deve repetir o aviso");
  finance = { ...finance, billingNotice: { ...finance.billingNotice, day: "2026-11-26", dismissedToday: false } }; broadcast();
  await waitFor(window, "Boolean(document.querySelector('.client-debt-dialog'))", "lembrete não reapareceu no dia seguinte");
  console.log("PASS: Pix correto, aviso fechado permanece oculto após reabrir e retorna no próximo dia.");
  snapshot.monitoringEnabled = true; broadcast();
  await waitFor(window, "!document.querySelector('.client-debt-dialog') && !document.querySelector('.client-debt-banner')", "aviso cobriu o bot armado");
  const requestsWhileArmed = billingRequests;
  await js("window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));");
  await delay(200);
  assert.equal(billingRequests, requestsWhileArmed, "não deve fazer consulta financeira enquanto armado");
  assert.equal(await js("getComputedStyle(document.querySelector('.client-debt-frame')).pointerEvents"), "none");
  console.log("PASS: armar oculta o aviso e suspende consultas; borda não intercepta cliques.");
  snapshot.monitoringEnabled = false; snapshot.performanceMetrics = { activeQueue: 1 }; broadcast();
  await delay(150);
  assert.equal(await js("Boolean(document.querySelector('.client-debt-dialog'))"), false, "ACK pendente ainda deve proteger o envio");
  assert.equal(billingRequests, requestsWhileArmed);
  snapshot.performanceMetrics.activeQueue = 0; broadcast();
  await waitFor(window, "Boolean(document.querySelector('.client-debt-dialog'))", "aviso não retornou após desarmar");
  // A slow read started before payment cannot resurrect the settled debt.
  holdResponse = true;
  await js("window.dispatchEvent(new Event('online'))");
  for (let i = 0; i < 80 && !pendingResponse; i++) await delay(20);
  assert.ok(pendingResponse);
  finance = { ...finance, amountCents: 0, unpaidRoutes: 0, overdue: false, billingNotice: undefined };
  broadcast();
  await waitFor(window, "!document.querySelector('.client-debt-frame')", "pagamento registrado não limpou o aviso");
  pendingResponse(); await delay(150);
  assert.equal(await js("Boolean(document.querySelector('.client-debt-dialog'))"), false);
  assert.equal(await js("localStorage.getItem('panelToken')"), "debt-test-token");
  console.log("PASS: quitação remove aviso e borda; resposta antiga não restaura débito nem altera o login.");
  holdResponse = false;
  finance = { ...finance, amountCents: 5000, principalCents: 5000, lateFeeCents: 0, daysUntilDue: 3, dueDate: "2026-11-29T23:59:59.999-03:00", billingNotice: { key: "next-period", day: "2026-11-26", phase: "upcoming", dismissedToday: false } }; broadcast();
  await waitFor(window, "document.querySelector('#client-debt-title')?.textContent.includes('3 dia')", "aviso antecipado não abriu");
  assert.equal(await js("Boolean(document.querySelector('.client-debt-pix'))"), false);
  assert.equal(await js("Boolean(document.querySelector('.client-debt-frame'))"), false);
  await js("document.querySelector('.client-debt-close').click()");
  await delay(100);
  for (const days of [2, 1]) {
    finance = { ...finance, daysUntilDue: days, billingNotice: { ...finance.billingNotice, day: `2026-11-${29-days}`, dismissedToday: false } }; broadcast();
    await waitFor(window, `document.querySelector('#client-debt-title')?.textContent.includes('${days} dia')`, "lembrete diário não voltou");
    await js("document.querySelector('.client-debt-close').click()"); await delay(100);
  }
  finance = { ...finance, daysUntilDue: 0, billingNotice: { ...finance.billingNotice, day: "2026-11-29", phase: "due_today", dismissedToday: false } }; broadcast();
  await waitFor(window, "document.querySelector('#client-debt-title')?.textContent.includes('Hoje')", "aviso do dia não apareceu");
  assert.match(await js("document.querySelector('.client-debt-fee-warning').textContent"), /amanhã.*0,50/);
  await js("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedPix=text}}});document.querySelector('.client-debt-pix button').click()");
  await waitFor(window, "window.__copiedPix==='91980984781'", "cópia da chave Pix falhou");
  console.log("PASS: alertas 3/2/1 dias antes, vencimento sem taxa, Pix e alerta de R$ 0,50 a partir de amanhã.");
  finance = { ...finance, paymentBlocked: true, overdue: true, dailyLateFeeCents: 75, billingNotice: { ...finance.billingNotice, phase: "blocked", dismissedToday: true } };
  snapshot.monitoringEnabled = true; broadcast();
  await waitFor(window, "Boolean(document.querySelector('.client-debt-dialog.payment-locked'))", "bloqueio não sobrepôs o monitoramento");
  assert.equal(await js("Boolean(document.querySelector('.client-debt-close,.client-debt-later'))"), false);
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.client-debt-backdrop').click();");
  assert.equal(await js("Boolean(document.querySelector('.client-debt-dialog.payment-locked'))"), true);
  assert.match(await js("document.querySelector('.client-debt-fee-warning').textContent"), /0,75/);
  assert.equal(await js("Boolean(document.querySelector('[inert]'))"), true, "conteúdo por trás ainda estava interativo");
  assert.match(await js("getComputedStyle(document.querySelector('.client-debt-dialog')).backgroundImage"), /66, 18, 30/);
  await delay(250);
  assert.equal(await js("Boolean(document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.client-debt-dialog'))"), true, "bloqueio não cobre a tela");
  window.webContents.invalidate(); await delay(200);
  fs.writeFileSync(path.resolve(__dirname, "../.audit-artifacts/client-payment-locked.png"), (await window.webContents.capturePage()).toPNG());
  finance = { ...finance, paymentBlocked: false, amountCents: 0, overdue: false, billingNotice: undefined }; snapshot.monitoringEnabled = false; broadcast();
  await waitFor(window, "!document.querySelector('.client-debt-dialog') && !document.querySelector('[inert]')", "pagamento não liberou a tela");
  console.log("PASS: bloqueio vermelho sem fechar/adiar/Escape, conteúdo inativo e pagamento libera a tela automaticamente.");
  window.destroy(); for (const stream of streams) stream.end(); server.close(); clearTimeout(deadline); app.quit();
})().catch(error => { console.error(error.stack || error); clearTimeout(deadline); app.exit(1); });
