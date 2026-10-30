const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { PanelUserStore } = require("../dist/panelUserStore");
const { LeaderStore } = require("../dist/leaderStore");
const { PushNotificationStore } = require("../dist/pushNotificationStore");
const { RequestRateLimiter } = require("../dist/httpSafety");
const { ImageUsageStore } = require("../dist/imageUsageStore");

const sessionSecret = "audit-only-session-signing-key";
async function startServer(directory) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/server.js")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATA_DIR: directory, PORT: "0", PANEL_USERS: "admin@test.com:test-password:admin,client@test.com:client-password:client", PANEL_ADMIN_EMAILS: "admin@test.com", PANEL_SESSION_SECRET: sessionSecret, ISOLATED_CLIENT_EMAIL: "", KEEP_ALIVE_WHEN_MONITORING: "false", DAILY_SESSION_RESET_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Test server startup timed out")); }, 10000);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Test server exited")); });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/Painel web: http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return {
    async request(url, method = "GET", body, token, headers = {}) {
      const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { "x-panel-token": token } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  };
}

test("HTTP: exclusão legada chega ao painel, cancela cobrança e permanece cancelada após reiniciar", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-route-http-"));
  const userDir = path.join(directory, "users", "client_test.com");
  fs.mkdirSync(userDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(userDir, "route_history.json"), JSON.stringify([{
    id: "deleted-http", clientEmail: "client@test.com", groupJid: "group@g.us", groupName: "Rotas", mode: "target",
    messages: ["Cliente J-29"], sentMessageIds: ["deleted-message"], confirmedCount: 1, totalCount: 1,
    status: "sent", createdAt: now, updatedAt: now, validated: true, decisionStatus: "validated", validatedBy: "Líder", validatedAt: now,
    deletedMessageIds: ["deleted-message"], reactions: []
  }]));
  const usage = new ImageUsageStore(path.join(directory, "image_usage.json"));
  usage.setRoutePrice("client@test.com", 500);
  usage.decideValidatedRoute({ routeDispatchId: "deleted-http", clientEmail: "client@test.com", messageId: "deleted-message", result: "detected" }, "Líder");
  const entryId = usage.snapshot().entries[0].id;
  let server = await startServer(directory);
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const login = await server.request("/api/login", "POST", { email: "admin@test.com", password: "test-password" });
  const token = login.data.token;
  async function waitForCancelled() {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { data } = await server.request("/api/admin/monitor", "GET", undefined, token);
      if (data.routes?.totals.deleted === 1 && data.imageUsage?.entries[0]?.cancellation) return data;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("O worker não reconciliou a exclusão com o financeiro");
  }
  const monitor = await waitForCancelled();
  assert.equal(monitor.routes.totals.validated, 0);
  assert.equal(monitor.routes.totals.pending, 0);
  assert.equal(monitor.routes.routes[0].validationBeforeDeletion.validatedBy, "Líder");
  assert.equal(monitor.imageUsage.totals.amountCents, 0);
  assert.equal(monitor.imageUsage.totals.unpaidRoutes, 0);
  assert.equal((await server.request(`/api/admin/image-usage/${encodeURIComponent(entryId)}`, "PATCH", { decision: "billable" }, token)).status, 409);
  assert.equal((await server.request("/api/admin/routes/deleted-http/validate", "PATCH", {}, token)).status, 404);
  const clientLogin = await server.request("/api/login", "POST", { email: "client@test.com", password: "client-password" });
  assert.equal((await server.request("/api/admin/monitor", "GET", undefined, clientLogin.data.token)).status, 403);
  const client = await server.request("/api/snapshot", "GET", undefined, clientLogin.data.token);
  assert.equal(client.data.routeDispatches[0].decisionStatus, "deleted");
  assert.equal(client.data.imageUsage.amountCents, 0);
  await server.close(); server = await startServer(directory);
  assert.equal((await waitForCancelled()).imageUsage.entries[0].cancellation.originalAmountCents, 500);
});

test("HTTP: valida entradas, revoga sessões e preserva usuários criados no painel após reinício", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-http-"));
  let server = await startServer(directory);
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await server.request("/api/admin/events")).status, 401);
  assert.equal((await server.request("/api/analysis-preview?id=photo")).status, 401);
  for (const body of ["null", "[]", "{broken"]) assert.equal((await server.request("/api/login", "POST", body)).status, 400);
  const login = await server.request("/api/login", "POST", { email: "admin@test.com", password: "test-password" });
  assert.equal(login.status, 200);
  const token = login.data.token;
  assert.equal((await server.request("/api/me", "GET", undefined, undefined, { "x-panel-password": "test-password" })).status, 401);
  const accounts = await server.request("/api/admin/users", "GET", undefined, token);
  assert.equal(accounts.data.users.find((user) => user.email === "admin@test.com").loginCount, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "panel_users.json"), "utf8"));
  assert.match(persisted[0].password, /^scrypt\$/);
  const claim = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  delete claim.exp;
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const invalidToken = `${payload}.${crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url")}`;
  assert.equal((await server.request("/api/me", "GET", undefined, invalidToken)).status, 401);
  assert.equal((await server.request("/api/admin/users", "POST", { email: "new@test.com", password: "new-password" }, token)).status, 200);
  assert.equal((await server.request("/api/admin/users", "POST", { email: "new@test.com", password: "another" }, token)).status, 409);
  assert.equal((await server.request("/api/admin/users", "POST", { email: "invalid", password: "another" }, token)).status, 400);
  assert.equal((await server.request("/api/admin/users/admin%40test.com", "PATCH", { color: "#112233" }, token)).status, 200);
  assert.equal((await server.request("/api/me", "GET", undefined, token)).data.role, "admin");
  assert.equal((await server.request("/api/admin/users/admin%40test.com", "PATCH", { blocked: true }, token)).status, 400);
  assert.equal((await server.request("/api/admin/users/new%40test.com", "PATCH", { email: "admin@test.com" }, token)).status, 409);
  for (const amountCents of [-1, null, "100", 1.5, 10000001]) {
    assert.equal((await server.request("/api/admin/image-total/new%40test.com", "PATCH", { amountCents }, token)).status, 400);
  }
  const clientLogin = await server.request("/api/login", "POST", { email: "new@test.com", password: "new-password" });
  assert.equal(clientLogin.status, 200);
  assert.equal((await server.request("/api/analysis-preview?client=admin%40test.com&id=photo", "GET", undefined, clientLogin.data.token)).status, 403);
  assert.equal((await server.request("/api/admin/users/new%40test.com", "PATCH", { password: "changed-password" }, token)).status, 200);
  assert.equal((await server.request("/api/me", "GET", undefined, clientLogin.data.token)).status, 401);
  const beforeBlock = await server.request("/api/login", "POST", { email: "new@test.com", password: "changed-password" });
  assert.equal(beforeBlock.status, 200);
  assert.equal((await server.request("/api/admin/users/new%40test.com", "PATCH", { blocked: true }, token)).status, 200);
  assert.equal((await server.request("/api/admin/users/new%40test.com", "PATCH", { blocked: false }, token)).status, 200);
  assert.equal((await server.request("/api/me", "GET", undefined, beforeBlock.data.token)).status, 401);
  await server.close();
  server = await startServer(directory);
  assert.equal((await server.request("/api/me", "GET", undefined, token)).status, 200);
  assert.equal((await server.request("/api/login", "POST", { email: "new@test.com", password: "changed-password" })).status, 200);
  assert.equal((await server.request("/api/logout", "POST", undefined, token)).status, 200);
  assert.equal((await server.request("/api/me", "GET", undefined, token)).status, 401);
  await server.close();
  server = await startServer(directory);
  assert.equal((await server.request("/api/me", "GET", undefined, token)).status, 401);
});

test("stores preservam arquivo inválido e exclusão intencional de líderes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-stores-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "users.json");
  fs.writeFileSync(file, "{truncated");
  assert.throws(() => new PanelUserStore(file).upsert({ email: "new@test.com", password: "test" }), /inválido/);
  assert.equal(fs.readFileSync(file, "utf8"), "{truncated");
  const leaders = new LeaderStore(path.join(directory, "leaders.json"), [{ name: "Test", phone: "5511999999999" }]);
  assert.equal(leaders.all().length, 1);
  leaders.remove("5511999999999");
  assert.deepEqual(leaders.all(), []);
});

test("push recusa destinos arbitrários, locais e host que imita provedor", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-push-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PushNotificationStore(path.join(directory, "push.json"));
  for (const endpoint of ["https://127.0.0.1/private", "http://fcm.googleapis.com/path", "https://fcm.googleapis.com.attacker.example/path", "https://user:pass@fcm.googleapis.com/path"]) {
    assert.throws(() => store.upsert("user@test.com", "client", { endpoint, keys: { p256dh: "test", auth: "test" } }), /autorizado/);
  }
});

test("limite de tentativas é independente por chave e expira", () => {
  const limiter = new RequestRateLimiter(2, 100);
  assert.equal(limiter.allow("a", 1000), true);
  assert.equal(limiter.allow("a", 1000), true);
  assert.equal(limiter.allow("a", 1000), false);
  assert.equal(limiter.allow("b", 1000), true);
  assert.equal(limiter.allow("a", 1101), true);
});
