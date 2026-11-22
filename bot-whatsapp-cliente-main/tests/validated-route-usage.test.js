const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ImageUsageStore } = require("../dist/imageUsageStore.js");
const { isAlwaysBillableValidatedRouteClient, validatedRouteUsagePayload } = require("../dist/validatedRouteUsage.js");

function route(id, trigger = "manual") {
  return {
    id, clientEmail: "fernando@teste.com", groupJid: "grupo@g.us", groupName: "Rotas",
    mode: "target", trigger, messages: ["Fernando B-25"], sentMessageIds: [`msg-${id}`],
    confirmedCount: 1, totalCount: 1, status: "sent", createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:01:00.000Z", validatedAt: "2026-09-27T10:02:00.000Z",
    validated: true, decisionStatus: "validated", reactions: []
  };
}

test("Fernando contabiliza qualquer rota validada pelo valor configurado sem duplicar", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fernando-usage-")), "usage.json");
  const store = new ImageUsageStore(file);
  store.setDefaultAmount("fernando@teste.com", 300);

  for (const [index, trigger] of ["manual", "automatic", "target-simulation"].entries()) {
    const current = route(`rota-${index}`, trigger);
    const payload = validatedRouteUsagePayload(current, current.clientEmail);
    assert.equal(store.decideValidatedRoute(payload, "admin@teste.com"), true);
    assert.equal(store.decideValidatedRoute(payload, "admin@teste.com"), false);
  }

  assert.equal(store.snapshot().totals.billable, 3);
  assert.equal(store.clientSnapshot("fernando@teste.com").amountCents, 900);
});

test("regra reconhece Fernando e permite email exato configurado sem atingir outros clientes", () => {
  assert.equal(isAlwaysBillableValidatedRouteClient("fernando.silva@teste.com", ""), true);
  assert.equal(isAlwaysBillableValidatedRouteClient("cliente@teste.com", "cliente@teste.com"), true);
  assert.equal(isAlwaysBillableValidatedRouteClient("alan@teste.com", ""), false);
});

test("todas as rotas validadas são cobradas, inclusive com preferência legada de somente IA", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "client-route-billing-")), "usage.json");
  const store = new ImageUsageStore(file);
  assert.equal(store.billsAllValidatedRoutes("cliente@teste.com"), true);
  store.setBillAllValidatedRoutes("cliente@teste.com", true);
  assert.equal(store.billsAllValidatedRoutes("cliente@teste.com"), true);
  assert.equal(store.snapshot().clients.find((client) => client.clientEmail === "cliente@teste.com").billAllValidatedRoutes, true);
  assert.equal(new ImageUsageStore(file).billsAllValidatedRoutes("cliente@teste.com"), true);

  store.setBillAllValidatedRoutes("fernando@teste.com", false);
  assert.equal(store.billsAllValidatedRoutes("fernando@teste.com"), true);
  assert.equal(new ImageUsageStore(file).billsAllValidatedRoutes("fernando@teste.com"), true);
});
