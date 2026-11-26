const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const { billingDayKey } = require("../dist/shared/billingPolicy");
const email = "guilherme@billing.test";
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-billing-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, "usage.json"); return { file, store: new ImageUsageStore(file) }; }

test("avisa nos três dias anteriores e no vencimento sem taxa; fechar vale até amanhã", t => {
  const { store, file } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2026-11-25" });
  const at = day => store.clientSnapshot(email, "2026-11", new Date(`2026-11-${day}T12:00:00Z`));
  assert.equal(at(21).billingNotice, undefined);
  for (const day of [22, 23, 24]) { assert.equal(at(day).billingNotice.phase, "upcoming"); assert.equal(at(day).amountCents, 5000); }
  const notice = at(22).billingNotice;
  store.dismissBillingNotice(email, notice.key, new Date("2026-11-22T12:00:00Z"));
  assert.equal(at(22).billingNotice.dismissedToday, true);
  assert.equal(new ImageUsageStore(file).clientSnapshot(email, "2026-11", new Date("2026-11-22T23:00:00Z")).billingNotice.dismissedToday, true);
  assert.equal(at(23).billingNotice.dismissedToday, false);
  assert.equal(at(25).billingNotice.phase, "due_today"); assert.equal(at(25).lateFeeCents, 0);
  assert.equal(at(26).billingNotice.phase, "overdue"); assert.equal(at(26).lateFeeCents, 50);
});

test("virada do lembrete usa o dia de São Paulo e não meia-noite UTC", t => {
  const { store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2026-11-25" });
  const before = new Date("2026-11-25T02:59:00Z"), after = new Date("2026-11-25T03:00:00Z");
  const notice = store.clientSnapshot(email, "2026-11", before).billingNotice;
  store.dismissBillingNotice(email, notice.key, before);
  assert.equal(billingDayKey(before), "2026-11-24");
  assert.equal(store.clientSnapshot(email, "2026-11", after).billingNotice.phase, "due_today");
  assert.equal(store.clientSnapshot(email, "2026-11", after).billingNotice.dismissedToday, false);
});

test("bloqueio financeiro persiste, permite desbloquear manualmente e some ao quitar", t => {
  const { store, file } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2026-01-01" });
  assert.equal(store.isPaymentBlocked(email), false);
  store.updateClientFinance(email, { paymentBlocked: true }, "admin");
  const restored = new ImageUsageStore(file);
  assert.equal(restored.isPaymentBlocked(email), true);
  assert.equal(restored.clientSnapshot(email).billingNotice.phase, "blocked");
  restored.updateClientFinance(email, { paymentBlocked: false }, "admin");
  assert.equal(restored.isPaymentBlocked(email), false);
  restored.updateClientFinance(email, { paymentBlocked: true }, "admin");
  restored.registerPayment(email, "admin");
  assert.equal(new ImageUsageStore(file).isPaymentBlocked(email), false);
  assert.equal(restored.clientSnapshot(email).billingNotice, undefined);
  assert.ok(restored.snapshot().financeEvents.some(event => event.type === "blocked"));
});

test("não bloqueia conta em dia; novo prazo gera novo aviso sem reaproveitar fechamento antigo", t => {
  const { store } = setup(t);
  store.updateClientFinance(email, { balanceCents: 5000, dueDate: "2099-01-01" });
  assert.throws(() => store.updateClientFinance(email, { paymentBlocked: true }), /atraso/);
  store.updateClientFinance(email, { dueDate: "2026-11-25" });
  const now = new Date("2026-11-23T12:00:00Z"), notice = store.clientSnapshot(email, "2026-11", now).billingNotice;
  store.dismissBillingNotice(email, notice.key, now);
  store.updateClientFinance(email, { dueDate: "2026-11-24" });
  const next = store.clientSnapshot(email, "2026-11", now).billingNotice;
  assert.notEqual(notice.key, next.key); assert.equal(next.dismissedToday, false);
  assert.throws(() => store.dismissBillingNotice(email, notice.key, now), /aviso mudou/);
});
