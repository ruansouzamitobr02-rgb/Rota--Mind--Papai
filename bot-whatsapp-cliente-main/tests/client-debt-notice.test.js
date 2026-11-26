const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getBillingDeadline } = require("../dist/shared/billingDeadline");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const { spawn } = require("node:child_process");

test("saldo antigo não ganha vencimento futuro automaticamente quando vira o mês", () => {
  const deadline = getBillingDeadline(15, new Date("2026-11-25T12:00:00Z"), "2026-09-01T12:00:00Z");
  assert.equal(deadline.dueDate.slice(0, 10), "2026-09-15");
  assert.equal(deadline.daysOverdue, 71);
  assert.equal(deadline.daysUntilDue, 0);
});

test("o dia do vencimento inteiro ainda está no prazo no horário de Brasília", () => {
  const atEnd = getBillingDeadline(15, new Date("2026-11-16T02:59:59Z"), "2026-11-01T12:00:00Z");
  assert.equal(atEnd.daysOverdue, 0);
  const nextDay = getBillingDeadline(15, new Date("2026-11-16T03:00:00Z"), "2026-11-01T12:00:00Z");
  assert.equal(nextDay.daysOverdue, 1);
});

test("novo período após pagamento não herda vencimento antigo; fevereiro limita dia 31", () => {
  assert.equal(getBillingDeadline(15, new Date("2026-11-25T12:00:00Z"), "2026-11-21T12:00:00Z", "2026-11-20T12:00:00Z").dueDate.slice(0, 10), "2026-12-15");
  assert.equal(getBillingDeadline(31, new Date("2026-03-02T12:00:00Z"), "2026-02-01T12:00:00Z").dueDate.slice(0, 10), "2026-02-28");
});

test("aviso usa o saldo real sem acrescentar taxa e some após registrar pagamento", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debt-notice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.json");
  const store = new ImageUsageStore(file);
  const email = "guilherme@test.com";
  store.setDueDay(email, 15);
  store.setRoutePrice(email, 500);
  store.decideValidatedRoute({ routeDispatchId: "old", messageId: "old", clientEmail: email, result: "detected" }, "admin");
  const data = JSON.parse(fs.readFileSync(file));
  data.entries[0].createdAt = data.entries[0].reviewedAt = "2026-11-01T12:00:00Z";
  fs.writeFileSync(file, JSON.stringify(data));
  const restored = new ImageUsageStore(file);
  const snapshot = restored.clientSnapshot(email, "2026-11", new Date("2026-11-25T12:00:00Z"));
  assert.equal(snapshot.overdue, true);
  assert.equal(snapshot.daysOverdue, 10);
  assert.equal(snapshot.amountCents, 500);
  restored.registerPayment(email);
  assert.equal(restored.clientSnapshot(email, "2026-11", new Date("2026-11-25T12:00:00Z")).overdue, false);
});

test("ciclo por quantidade é preservado sem cobrança por calendário antes do limite", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debt-cadence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ImageUsageStore(path.join(dir, "usage.json"));
  const email = "fernando@test.com";
  for (let i = 0; i < 10; i++) {
    store.decideValidatedRoute({ routeDispatchId: String(i), messageId: String(i), clientEmail: email, result: "detected" }, "admin");
    assert.equal(store.clientSnapshot(email).overdue, i === 9);
  }
  store.registerPayment(email);
  assert.equal(store.clientSnapshot(email).overdue, false);
});

test("HTTP: situação financeira é privada e quitação do administrador limpa o aviso", { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debt-http-"));
  const admin = "admin@debt.test", client = "guilherme@debt.test", other = "other@debt.test";
  const store = new ImageUsageStore(path.join(dir, "image_usage.json"));
  store.setRoutePrice(client, 500);
  store.decideValidatedRoute({ routeDispatchId: "first", messageId: "first", clientEmail: client, result: "detected" }, "admin");
  const data = JSON.parse(fs.readFileSync(path.join(dir, "image_usage.json")));
  data.entries[0].reviewedAt = data.entries[0].createdAt = "2026-01-01T12:00:00Z";
  fs.writeFileSync(path.join(dir, "image_usage.json"), JSON.stringify(data));
  let logs = "";
  const child = spawn(process.execPath, ["-e", "require(process.argv[1]);process.on('message',s=>process.emit(s,s));", path.resolve(__dirname, "../dist/server.js")], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dir, PORT: "0", NODE_ENV: "test", RENDER: "", PANEL_USERS: `${admin}:test-password:admin,${client}:test-password:client,${other}:test-password:client`,
      PANEL_ADMIN_EMAILS: admin, PANEL_SESSION_SECRET: "debt-http-test-session-secret", BOT_EAGER_WORKERS: "false", RENDER_EXTERNAL_URL: "", KEEP_ALIVE_URL: "", ISOLATED_CLIENT_EMAIL: "", R2_ENDPOINT: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null) child.send("SIGTERM");
    const timer = setTimeout(() => child.kill(), 5000);
    await exited; clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 10000);
    child.stdout.on("data", chunk => {
      const match = String(chunk).match(/Painel web: http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const request = (url, token, method = "GET") => fetch(base + url, { method, headers: token ? { "x-panel-token": token } : {}, signal: AbortSignal.timeout(8000) });
  const login = async email => {
    const response = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "test-password" }) });
    assert.equal(response.status, 200); return (await response.json()).token;
  };
  assert.equal((await request("/api/billing/status")).status, 401);
  const clientToken = await login(client), otherToken = await login(other), adminToken = await login(admin);
  const revealPath = `/api/admin/users/${encodeURIComponent(client)}/password/reveal`;
  assert.equal((await request(revealPath, undefined, "POST")).status, 401);
  assert.equal((await request(revealPath, otherToken, "POST")).status, 403);
  const revealed = await request(revealPath, adminToken, "POST");
  assert.match(revealed.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await revealed.json(), { available: true, password: "test-password" });
  const publicUsers = await (await request("/api/admin/users", adminToken)).text();
  assert.ok(!publicUsers.includes("password") && !publicUsers.includes("scrypt$") && !publicUsers.includes("test-password"));
  const settingsPath = "/api/admin/billing-settings";
  const settings = (token, cents) => fetch(base + settingsPath, { method: "PATCH", headers: { "x-panel-token": token, "content-type": "application/json" }, body: JSON.stringify({ dailyLateFeeCents: cents }) });
  assert.equal((await settings(clientToken, 75)).status, 403);
  assert.equal((await settings(adminToken, -1)).status, 400);
  const updatedSettings = await settings(adminToken, 75);
  assert.equal(updatedSettings.status, 200);
  assert.equal((await updatedSettings.json()).billingSettings.dailyLateFeeCents, 75);
  const status = await (await request(`/api/billing/status?email=${other}`, clientToken)).json();
  assert.equal(status.amountCents, 500); assert.equal(status.overdue, true);
  assert.equal((await (await request(`/api/billing/status?email=${client}`, otherToken)).json()).amountCents, 0);
  assert.equal((await request(`/api/admin/client-payment/${client}`, clientToken, "POST")).status, 403);
  const patch = body => fetch(base + `/api/admin/client-finance/${client}`, { method: "PATCH", headers: { "x-panel-token": adminToken, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await patch({ balanceCents: 12345, dueDate: "2027-02-31" })).status, 400);
  assert.equal((await (await request("/api/billing/status", clientToken)).json()).amountCents, 500);
  const notice = (await (await request("/api/billing/status", clientToken)).json()).billingNotice;
  const dismiss = token => fetch(base + "/api/billing/dismiss", { method: "POST", headers: { "x-panel-token": token, "content-type": "application/json" }, body: JSON.stringify({ key: notice.key }) });
  assert.equal((await dismiss(clientToken)).status, 200);
  assert.equal((await (await request("/api/billing/status", clientToken)).json()).billingNotice.dismissedToday, true);
  assert.equal((await dismiss(otherToken)).status, 409);
  assert.equal((await patch({ paymentBlocked: true })).status, 200);
  assert.equal((await dismiss(clientToken)).status, 423);
  assert.equal((await request("/api/romaneio/clear", clientToken, "POST")).status, 423);
  assert.equal((await request("/api/me", clientToken)).status, 200);
  for (const action of ["start", "restart", "start-monitoring", "start-image-monitoring", "start-nuclear-monitoring", "start-test-monitoring", "manual-dispatch", "simulate-opening"]) {
    assert.equal((await request(`/api/action/${action}`, clientToken, "POST")).status, 423, `bloqueio não protegeu ${action}`);
  }
  assert.equal((await request(`/api/admin/users/${client}/action/start-monitoring`, adminToken, "POST")).status, 423);
  assert.equal((await patch({ paymentBlocked: false })).status, 200);
  const edited = await patch({ balanceCents: 12345, dueDate: "2027-01-15" });
  assert.equal(edited.status, 200);
  const customer = (await edited.json()).clients.find(item => item.clientEmail === client);
  assert.equal(customer.principalCents, 12345); assert.equal(customer.routePriceCents, 500);
  assert.equal(customer.configuredDueDate, "2027-01-15");
  assert.equal((await request(`/api/admin/client-payment/${client}`, adminToken, "POST")).status, 200);
  const paid = await (await request("/api/billing/status", clientToken)).json();
  assert.equal(paid.amountCents, 0); assert.equal(paid.overdue, false);
});
