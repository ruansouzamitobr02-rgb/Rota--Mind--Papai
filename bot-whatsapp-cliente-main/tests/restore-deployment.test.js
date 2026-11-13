const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { PanelUserStore } = require("../dist/panelUserStore");
const { getRestoreStorageStatus, inspectRestoreSnapshot } = require("../dist/services/restoreIntegrity");
const {
  applyPreparedCloudRestore, completeCloudRestoreOnStartup, getCloudRestoreStatus,
  recoverInterruptedCloudRestore, setCloudRestoreStatus
} = require("../dist/services/cloudBackup");

const adminEmail = "admin@test.com";
const passphrase = "backup-migracao-teste-1234";
async function startServer(dataDir, extraEnv = {}) {
  let logs = "";
  const child = spawn(process.execPath, ["-e", `require(process.argv[1]); process.on('message', signal => process.emit(signal, signal));`, path.resolve(__dirname, "../dist/server.js")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dataDir, PORT: "0", RENDER: "", NODE_ENV: "test", PANEL_USERS: `${adminEmail}:senha-do-novo-site:admin`, PANEL_ADMIN_EMAILS: adminEmail,
      PANEL_SESSION_SECRET: "restore-test-session-secret", BOT_EAGER_WORKERS: "false", KEEP_ALIVE_URL: "", RENDER_EXTERNAL_URL: "", RENDER_EXTERNAL_HOSTNAME: "",
      KEEP_ALIVE_WHEN_MONITORING: "false", DAILY_SESSION_RESET_ENABLED: "false", R2_ENDPOINT: "", ISOLATED_CLIENT_EMAIL: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup timed out: ${logs}`)); }, 15000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Startup failed: ${logs}`)); });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/Painel web: http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  let token;
  async function request(url, method = "GET", body, headers = {}) {
    return fetch(base + url, {
      method, headers: { ...(token ? { "x-panel-token": token } : {}), "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
  }
  return {
    child, exited, request, get logs() { return logs; },
    async login(email = adminEmail, password = "senha-do-novo-site") {
      const response = await request("/api/login", "POST", { email, password });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      token = data.token;
    },
    async close(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.send(signal);
      return Promise.race([exited, new Promise((_, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Shutdown timed out: ${logs}`)); }, 15000);
        timer.unref();
        exited.then(() => clearTimeout(timer));
      })]);
    }
  };
}

test("restauração só é concluída após conferir os arquivos na próxima inicialização", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restore-verify-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = path.join(directory, ".cloud-restore-stage-test");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(directory, "original.json"), JSON.stringify({ original: true }));
  fs.writeFileSync(path.join(stage, "restaurado.json"), JSON.stringify({ novo: true }));
  setCloudRestoreStatus(directory, { phase: "ready", message: "Pronto", sourceKey: "teste.rmbak" });
  await applyPreparedCloudRestore(directory, stage);
  assert.equal(getCloudRestoreStatus(directory).phase, "restarting");
  assert.ok(fs.existsSync(path.join(directory, ".cloud-restore-journal.json")));
  recoverInterruptedCloudRestore(directory);
  completeCloudRestoreOnStartup(directory);
  assert.equal(getCloudRestoreStatus(directory).phase, "completed");
  assert.equal(getCloudRestoreStatus(directory).summary.files, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "restaurado.json"))), { novo: true });
});

test("arquivo restaurado alterado ou perdido antes de reiniciar recupera os dados anteriores", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restore-verify-failed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = path.join(directory, ".cloud-restore-stage-test");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(directory, "original.json"), '{"original":true}');
  fs.writeFileSync(path.join(stage, "novo.json"), '{"novo":true}');
  setCloudRestoreStatus(directory, { phase: "ready", message: "Pronto" });
  await applyPreparedCloudRestore(directory, stage);
  fs.writeFileSync(path.join(directory, "novo.json"), '{"novo":false}');
  recoverInterruptedCloudRestore(directory);
  assert.equal(getCloudRestoreStatus(directory).phase, "failed");
  assert.equal(fs.readFileSync(path.join(directory, "original.json"), "utf8"), '{"original":true}');
  assert.equal(fs.existsSync(path.join(directory, "novo.json")), false);
});

test("arquivo JSON inválido não vira importação concluída", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restore-invalid-json-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "panel_users.json"), "{incompleto");
  assert.throws(() => inspectRestoreSnapshot(directory), /inválido/);
});

test("Render exige um disco montado no caminho real de DATA_DIR, além de permissão de escrita", () => {
  // Use the platform's resolved path so the parser is exercised on Windows too.
  const data = path.resolve("/data");
  const root = "1 0 0:1 / / rw - overlay overlay rw\n";
  const persistent = `2 1 8:1 / ${data} rw - ext4 /dev/disk rw\n`;
  assert.equal(getRestoreStorageStatus(data, { render: true, platform: "linux", mountInfo: root }).ready, false);
  assert.equal(getRestoreStorageStatus(data, { render: true, platform: "linux", mountInfo: root + persistent }).ready, true);
  assert.equal(getRestoreStorageStatus(data, { render: true, platform: "linux", mountInfo: root + persistent.replace("ext4", "tmpfs") }).ready, false);
  assert.equal(getRestoreStorageStatus(path.resolve("/outro"), { render: true, platform: "linux", mountInfo: root + persistent }).ready, false);
  assert.equal(getRestoreStorageStatus(data, { render: false, platform: "win32", mountInfo: "" }).ready, true);
});

test("HTTP: exporta, importa em outro serviço, mantém login, clientes e rotas após dois reinícios", { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-http-migration-"));
  let server;
  t.after(async () => { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const userDir = path.join(source, "users", "antigo_test.com");
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(target);
  const store = new PanelUserStore(path.join(source, "panel_users.json"));
  store.upsert({ email: adminEmail, password: "senha-do-site-antigo", role: "admin", source: "environment" });
  store.upsert({ email: "antigo@test.com", password: "senha-cliente-antigo", role: "client", source: "environment" });
  const { ImageUsageStore } = require("../dist/imageUsageStore");
  const usage = new ImageUsageStore(path.join(source, "image_usage.json"));
  usage.setRoutePrice("antigo@test.com", 500);
  usage.setPrepaidRoutes("antigo@test.com", 10);
  const { ConfigStore } = require("../dist/bot/config");
  const config = new ConfigStore(path.join(userDir, "config.json"));
  config.save({ rotasMonitoradasDetalhadas: [{ cidade: "", bairro: "Centro", regiao: "Campos - Tamandaré", enabled: true }], codigosMensagensAlvo: ["J-29"] });
  const route = { id: "migrada", clientEmail: "antigo@test.com", groupJid: "teste@g.us", mode: "target", messages: ["J-29"], sentMessageIds: ["msg"], confirmedCount: 1, totalCount: 1, status: "sent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reactions: [], validated: true, decisionStatus: "validated" };
  fs.writeFileSync(path.join(userDir, "route_history.json"), JSON.stringify([route]));
  server = await startServer(source, { PANEL_USERS: `${adminEmail}:senha-do-site-antigo:admin,antigo@test.com:senha-cliente-antigo:client` });
  await server.login(adminEmail, "senha-do-site-antigo");
  const exported = await server.request("/api/admin/portable-backup/export", "POST", undefined, { "x-backup-passphrase": passphrase });
  assert.equal(exported.status, 200);
  const archive = Buffer.from(await exported.arrayBuffer());
  assert.equal((await server.close()).code, 0, server.logs);
  assert.doesNotMatch(server.logs, /afterStop is not a function/);
  server = await startServer(target);
  await server.login();
  // A destination worker already has empty, cached state before the import.
  assert.equal((await server.request("/api/snapshot")).status, 200);
  const response = await server.request("/api/admin/portable-backup/preview", "POST", archive, { "x-backup-passphrase": passphrase, "content-type": "application/octet-stream" });
  const preview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(preview));
  assert.equal(preview.summary.clients, 1);
  assert.equal(preview.summary.routes, 1);
  const apply = await server.request("/api/admin/portable-backup/apply", "POST", { ticket: preview.ticket, confirmation: "IMPORTAR DADOS" });
  assert.equal(apply.status, 202, await apply.text());
  const result = await Promise.race([server.exited, new Promise((_, reject) => { const timer = setTimeout(() => { server.child.kill(); reject(new Error(server.logs)); }, 15000); timer.unref(); server.exited.then(() => clearTimeout(timer)); })]);
  assert.equal(result.code, 0, server.logs);
  for (let restart = 0; restart < 2; restart++) {
    server = await startServer(target);
    await server.login(); // Different admin password on the destination is retained.
    const status = await (await server.request("/api/admin/cloud-backup/restore-status")).json();
    assert.equal(status.phase, "completed", JSON.stringify(status));
    assert.equal(status.summary.clients, 1);
    assert.equal(status.summary.routes, 1);
    assert.equal(status.summary.validatedRoutes, 1);
    const users = await (await server.request("/api/admin/users")).json();
    assert.ok(users.users.some((user) => user.email === "antigo@test.com"));
    await server.login("antigo@test.com", "senha-cliente-antigo");
    let snapshot;
    for (let attempt = 0; attempt < 60; attempt++) {
      snapshot = await (await server.request("/api/snapshot")).json();
      if (snapshot.config?.codigosMensagensAlvo?.includes("J-29")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(snapshot.config.codigosMensagensAlvo, ["J-29"]);
    assert.equal(snapshot.config.rotasMonitoradasDetalhadas[0].regiao, "Campos - Tamandaré");
    const finance = new ImageUsageStore(path.join(target, "image_usage.json")).snapshot().clients.find((client) => client.clientEmail === "antigo@test.com");
    assert.equal(finance.routePriceCents, 500);
    assert.equal(finance.prepaidRoutesRemaining, 10);
    // Both user profile and persisted neighborhood/cage preferences survive.
    const saved = JSON.parse(fs.readFileSync(path.join(target, "users", "antigo_test.com", "config.json"), "utf8"));
    assert.deepEqual(saved.codigosMensagensAlvo, ["J-29"]);
    assert.equal(saved.rotasMonitoradasDetalhadas[0].regiao, "Campos - Tamandaré");
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "users", "antigo_test.com", "route_history.json"))).length, 1);
    assert.equal((await server.close(restart ? "SIGINT" : "SIGTERM")).code, 0, server.logs);
    assert.doesNotMatch(server.logs, /afterStop is not a function/);
  }
});

test("HTTP: restauração sem disco persistente no Render é recusada antes de reiniciar", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restore-no-disk-"));
  const server = await startServer(directory, { RENDER: "true" });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await server.login();
  const response = await server.request("/api/admin/portable-backup/preview", "POST", Buffer.alloc(40), { "x-backup-passphrase": passphrase });
  const data = await response.json();
  assert.equal(response.status, 409);
  assert.match(data.error, /Disks/);
  assert.equal((await server.request("/api/me")).status, 200);
});

test("HTTP: versão publicada e referência de erro identificam falha no login sem registrar senha", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "restore-login-error-"));
  const server = await startServer(directory, { APP_RELEASE_ID: "diagnostico-deploy-teste", RENDER_GIT_COMMIT: "" });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ping = await (await server.request("/api/ping")).json();
  assert.equal(ping.release, "diagnostico-deploy-teste");
  assert.equal(ping.restoreVerification, true);
  await server.login();
  fs.writeFileSync(path.join(directory, "panel_users.json"), "{incompleto");
  const response = await server.request("/api/login", "POST", { email: adminEmail, password: "senha-do-novo-site" });
  const data = await response.json();
  assert.equal(response.status, 500);
  assert.match(data.requestId, /^[a-f0-9]{12}$/);
  assert.equal(response.headers.get("x-request-id"), data.requestId);
  assert.match(server.logs, new RegExp(`HTTP ${data.requestId}.*POST /api/login`));
  assert.ok(!server.logs.includes("senha-do-novo-site"));
  assert.equal(fs.readFileSync(path.join(directory, "panel_users.json"), "utf8"), "{incompleto");
});

test("login distingue gateway HTML durante reinício de senha incorreta e não apaga sessão", async (t) => {
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  global.window = { localStorage: { getItem: () => "" } };
  t.after(() => { global.window = previousWindow; global.fetch = previousFetch; });
  const { panelLogin, isAuthError } = require("../dist/desktop/renderer/api");
  global.fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  await assert.rejects(panelLogin(adminEmail, "senha-teste"), (error) => {
    assert.match(error.message, /reiniciando.*HTTP 502/);
    assert.equal(isAuthError(error), false);
    return true;
  });
  global.fetch = async () => new Response(JSON.stringify({ error: "Email ou senha invalidos." }), { status: 401 });
  await assert.rejects(panelLogin(adminEmail, "senha-teste"), (error) => {
    assert.equal(error.message, "Email ou senha invalidos.");
    assert.equal(isAuthError(error), true);
    return true;
  });
});
