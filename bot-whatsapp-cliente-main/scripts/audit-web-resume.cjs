const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { DEFAULT_CONFIG } = require("../dist/bot/config");

if (!process.env.DESKTOP_AUDIT_DATA_DIR) throw new Error("Use run-desktop-audit.cjs audit-web-resume.cjs");
app.setPath("userData", process.env.DESKTOP_AUDIT_DATA_DIR);
const rendererDir = path.resolve(__dirname, "../dist/desktop/renderer");
const streams = new Set();
let connections = 0;
let invalid = false;
const snapshot = {
  status: "disconnected", groupState: "unknown", qrCode: "",
  config: { ...DEFAULT_CONFIG, nomeEnvio: "Cliente de teste" },
  groups: [], logs: [], readinessChecks: [], routeDispatches: [], statusEvents: []
};
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const json = (data) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  if (pathname === "/api/me") return json({ email: "client@resume.test", role: "client" });
  if (pathname === "/api/release") return json({ shouldShow: false });
  if (pathname === "/api/snapshot") return json(invalid ? {} : snapshot);
  if (pathname === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify(invalid ? {} : snapshot)}\n\n`);
    connections++;
    streams.add(response);
    request.on("close", () => streams.delete(response));
    return;
  }
  if (pathname === "/boundary-test") { response.end("<!doctype html><div id='root'></div>"); return; }
  const target = path.resolve(rendererDir, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!target.startsWith(rendererDir + path.sep) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(target)] || "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  fs.createReadStream(target).pipe(response);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(window, expression, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await delay(50);
  }
  throw new Error(message);
}

const deadline = setTimeout(() => { console.error("Web resume audit timed out"); app.exit(1); }, 35_000);
(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false } });
  await window.loadURL(base);
  await window.webContents.executeJavaScript(`localStorage.setItem('panelToken','resume-test-token'); localStorage.setItem('panelUserRole','client'); localStorage.setItem('panelUserEmail','client@resume.test');`);
  await window.loadURL(base + "/?tab=settings");
  await waitFor(window, "Boolean(document.querySelector('.support-card textarea'))", "painel autenticado não abriu");
  await window.webContents.executeJavaScript(`
    const field = document.querySelector('.support-card textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'rascunho preservado');
    field.dispatchEvent(new Event('input',{bubbles:true}));
    window.__auditHidden = false;
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__auditHidden?'hidden':'visible'});
    true;
  `);
  const initialConnections = connections;
  invalid = true;
  await window.webContents.executeJavaScript(`window.__auditHidden=true; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide'));`);
  await delay(100);
  await window.webContents.executeJavaScript(`window.__auditHidden=false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); window.dispatchEvent(new Event('focus'));`);
  await delay(350);
  const resumed = await window.webContents.executeJavaScript(`({
    content:document.getElementById('root').innerText.length,
    draft:document.querySelector('.support-card textarea')?.value,
    token:localStorage.getItem('panelToken'),
    recovery:!!document.querySelector('.app-recovery-screen'),
    painted:document.querySelector('.app-shell')?.getBoundingClientRect().height > 0
  })`);
  assert.ok(connections > initialConnections, "SSE não foi reaberto após a suspensão");
  assert.ok(resumed.content > 100 && resumed.painted, "painel voltou vazio");
  assert.equal(resumed.draft, "rascunho preservado");
  assert.equal(resumed.token, "resume-test-token");
  assert.equal(resumed.recovery, false, "snapshot parcial derrubou a interface");
  invalid = false;
  for (const stream of streams) stream.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  await window.webContents.executeJavaScript(`document.querySelector('.bottom-nav button').click()`);
  await waitFor(window, "Boolean(document.querySelector('.mobile-home'))", "navegação ficou sem resposta após retomar");
  console.log("PASS: app móvel retoma, refaz SSE, recusa snapshot parcial e preserva login, formulário e navegação.");

  const boundary = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await boundary.loadURL(base + "/boundary-test");
  const boundaryPath = path.join(rendererDir, "AppRecoveryBoundary.js");
  const reactPath = path.resolve(__dirname, "../node_modules/react");
  const domPath = path.resolve(__dirname, "../node_modules/react-dom/client");
  await boundary.webContents.executeJavaScript(`
    const React = require(${JSON.stringify(reactPath)});
    const {createRoot} = require(${JSON.stringify(domPath)});
    const {AppRecoveryBoundary} = require(${JSON.stringify(boundaryPath)});
    window.__healthy = false;
    function Flaky() { if(!window.__healthy) throw new Error('simulação de erro após retomada'); return React.createElement('p',null,'painel recuperado'); }
    createRoot(document.getElementById('root')).render(React.createElement(AppRecoveryBoundary,null,React.createElement(Flaky)));
  `);
  await waitFor(boundary, "Boolean(document.querySelector('.app-recovery-screen'))", "erro de renderização deixou tela vazia");
  await boundary.webContents.executeJavaScript("window.__healthy = true");
  await waitFor(boundary, "document.getElementById('root').textContent.includes('painel recuperado')", "interface não recuperou automaticamente");
  assert.equal(await boundary.webContents.executeJavaScript("localStorage.getItem('panelToken')"), "resume-test-token");
  console.log("PASS: falha real de renderização mostra recuperação e reabre a tela automaticamente com login preservado.");
  boundary.destroy();
  window.destroy();
  for (const stream of streams) stream.end();
  server.close();
  clearTimeout(deadline);
  app.quit();
})().catch((error) => { console.error(error.stack || error); clearTimeout(deadline); app.exit(1); });
