const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ImageUsageStore, FinanceValidationError } = require("../dist/imageUsageStore");
const { isBillingDate } = require("../dist/shared/billingDeadline");
const email = "guilherme@finance.test";
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-finance-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, "usage.json"); return { file, store: new ImageUsageStore(file) }; }

test("saldo manual pertence ao cliente, persiste entre meses e não altera preço da rota", t => {
  const { file, store } = setup(t);
  store.setRoutePrice(email, 500);
  store.updateClientFinance(email, { balanceCents: 12345, dueDate: "2027-01-15" }, "admin@test.com");
  for (const month of ["2026-11", "2026-12", "2027-01"]) assert.equal(new ImageUsageStore(file).clientSnapshot(email, month, new Date("2026-11-25T12:00:00Z")).principalCents, 12345);
  assert.equal(store.snapshot().clients[0].routePriceCents, 500);
  store.decideValidatedRoute({ routeDispatchId: "new", clientEmail: email, messageId: "new", result: "detected" }, "admin");
  assert.equal(store.clientSnapshot(email).principalCents, 12845);
});

test("data exata domina prazo antigo e a taxa é simples por dia de São Paulo", t => {
  const { store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 10000, dueDate: "2026-11-15" });
  let before = store.clientSnapshot(email, "2026-11", new Date("2026-11-16T02:59:59Z"));
  assert.equal(before.amountCents, 10000); assert.equal(before.overdue, false);
  const after = store.clientSnapshot(email, "2026-11", new Date("2026-11-16T03:00:00Z"));
  assert.equal(after.lateFeeCents, 50); assert.equal(after.amountCents, 10050);
  const later = store.clientSnapshot(email, "2026-11", new Date("2026-11-25T12:00:00Z"));
  assert.equal(later.principalCents, 10000); assert.equal(later.lateFeeCents, 500); assert.equal(later.amountCents, 10500);
  assert.deepEqual(store.clientSnapshot(email, "2026-11", new Date("2026-11-25T12:00:00Z")), later);
});

test("salvar só a data não redefine saldo e uma data inválida não aplica parte da alteração", t => {
  const { store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2026-11-15" });
  store.updateClientFinance(email, { dueDate: "2027-01-10" });
  assert.equal(store.clientSnapshot(email).principalCents, 5000);
  assert.equal(store.clientSnapshot(email).overdue, false);
  assert.throws(() => store.updateClientFinance(email, { balanceCents: 10, dueDate: "2027-02-31" }), FinanceValidationError);
  assert.equal(store.clientSnapshot(email).principalCents, 5000);
  assert.equal(store.snapshot().clients[0].configuredDueDate, "2027-01-10");
  for (const invalid of ["2026-13-01", "2026-02-29", "25/11/2026", "2026-11-25T00:00:00Z"]) assert.equal(isBillingDate(invalid), false);
});

test("quitação zera saldo e taxa, preserva histórico e pede novo prazo para o próximo ciclo", t => {
  const { file, store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 7500, dueDate: "2026-01-01" }, "admin");
  const total = store.clientSnapshot(email).amountCents;
  store.registerPayment(email, "admin");
  const next = new ImageUsageStore(file);
  assert.equal(next.clientSnapshot(email).amountCents, 0); assert.equal(next.clientSnapshot(email).lateFeeCents, 0);
  assert.equal(next.snapshot().clients[0].configuredDueDate, null);
  const paid = next.snapshot().financeEvents.find(event => event.type === "payment");
  assert.equal(paid.amountCents, total); assert.equal(paid.performedBy, "admin");
  next.decideValidatedRoute({ routeDispatchId: "next", clientEmail: email, messageId: "next", result: "detected" }, "admin");
  assert.equal(next.clientSnapshot(email).overdue, false);
});

test("falha no disco desfaz saldo, prazo e auditoria juntos", t => {
  const { file, store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2027-01-10" });
  const before = store.snapshot(), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === file) throw new Error("ENOSPC"); return rename(from, to); };
    assert.throws(() => store.updateClientFinance(email, { balanceCents: 9000, dueDate: "2027-02-10" }), /ENOSPC/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.snapshot(), before);
});

test("renomear conta preserva saldo manual, data e eventos sem afetar outra conta", t => {
  const { file, store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2027-01-10" });
  store.renameClientEmail(email, "new@finance.test");
  const restored = new ImageUsageStore(file);
  assert.equal(restored.clientSnapshot("new@finance.test").principalCents, 5000);
  assert.equal(restored.clientSnapshot(email).amountCents, 0);
  assert.equal(restored.snapshot().clients.find(client => client.clientEmail === "new@finance.test").configuredDueDate, "2027-01-10");
  assert.ok(restored.snapshot().financeEvents.every(event => event.clientEmail === "new@finance.test"));
});

test("nova data troca ciclo por quantidade; sem data explícita não inventa taxa retroativa", t => {
  const { store } = setup(t);
  const fernando = "fernando@finance.test";
  store.updateClientFinance(fernando, { balanceCents: 5000 });
  assert.equal(store.clientSnapshot(fernando).dailyLateFeeCents, 0);
  store.updateClientFinance(fernando, { dueDate: "2026-11-01" });
  assert.equal(store.paymentEveryRoutes(fernando), 0);
  assert.equal(store.clientSnapshot(fernando, "2026-11", new Date("2026-11-03T12:00:00Z")).lateFeeCents, 100);
  store.updateClientFinance(fernando, { paymentEveryRoutes: 10 });
  assert.equal(store.clientSnapshot(fernando).dailyLateFeeCents, 0);
});
