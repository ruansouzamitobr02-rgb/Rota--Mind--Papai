const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RouteStore } = require("../dist/bot/routeStore");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const { BotService } = require("../dist/bot/connection");
const { validatedRouteUsagePayload } = require("../dist/validatedRouteUsage");
const { getRouteDecisionStatus, isRouteDeleted } = require("../dist/shared/routeLifecycle");

const email = "client@test.com";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-routes-"));
  const routesFile = path.join(directory, "routes.json");
  const usageFile = path.join(directory, "usage.json");
  const routes = new RouteStore(routesFile);
  const usage = new ImageUsageStore(usageFile);
  usage.setRoutePrice(email, 500);
  t.after(() => { routes.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, routesFile, usageFile, routes, usage };
}
function create(routes, id = "route", extra = {}) {
  return routes.create({
    id, clientEmail: email, groupJid: "group@g.us", groupName: "Rotas", mode: "target", trigger: "automatic",
    messages: ["Cliente J-29"], sentMessageIds: [`msg-${id}`], confirmedCount: 1, totalCount: 1, status: "sent", ...extra
  });
}
function approve(routes, usage, id = "route") {
  assert.equal(routes.validateBySentMessageId(`msg-${id}`, "Líder", { source: "leader_reaction_1h", reactionAt: "2026-10-29T12:00:00.000Z" }), true);
  return usage.decideValidatedRoute(validatedRouteUsagePayload(routes.all().find((route) => route.id === id), email), "Líder");
}

test("mensagem apagada cancela validação, preserva prova anterior e não pode ser revalidada", (t) => {
  const { routes, routesFile, usage } = fixture(t);
  create(routes);
  approve(routes, usage);
  assert.equal(routes.recordDeletedMessage("msg-route", { groupJid: "other@g.us" }), false);
  assert.equal(routes.recordDeletedMessage("msg-route", { groupJid: "group@g.us", actor: "client", actorJid: "5511999999999@s.whatsapp.net", source: "update" }), true);
  const route = routes.all()[0];
  assert.equal(getRouteDecisionStatus(route), "deleted");
  assert.equal(route.validated, false);
  assert.equal(route.validatedAt, undefined);
  assert.equal(route.validationBeforeDeletion.validatedBy, "Líder");
  assert.equal(route.validationBeforeDeletion.decisionSource, "leader_reaction_1h");
  assert.equal(route.deletionEvents[0].actor, "client");
  assert.equal(routes.validate("route", "admin"), false);
  assert.equal(routes.validateBySentMessageId("msg-route", "Líder"), false);
  assert.equal(routes.reject("route", "admin"), false);
  assert.equal(routes.recordDeletedMessage("msg-route"), false);
  routes.flush();
  const reloaded = new RouteStore(routesFile).all()[0];
  assert.equal(reloaded.decisionStatus, "deleted");
  assert.deepEqual(reloaded.validationBeforeDeletion, route.validationBeforeDeletion);
});

test("cancelamento retira saldo e ciclo de cobrança uma única vez, mesmo após reiniciar", (t) => {
  const { routes, usage, usageFile } = fixture(t);
  create(routes); approve(routes, usage);
  assert.equal(usage.clientSnapshot(email).amountCents, 500);
  routes.recordDeletedMessage("msg-route");
  assert.equal(usage.cancelDeletedRoutes(routes.all(), email), true);
  assert.equal(usage.clientSnapshot(email).amountCents, 0);
  assert.equal(usage.clientSnapshot(email).unpaidRoutes, 0);
  assert.equal(usage.snapshot().totals.billable, 0);
  const entry = usage.snapshot().entries[0];
  assert.equal(entry.cancellation.originalAmountCents, 500);
  assert.equal(entry.cancellation.previousDecision, "billable");
  assert.equal(usage.decide(entry.id, "billable", "admin"), false);
  assert.equal(usage.decideValidatedRoute(validatedRouteUsagePayload(routes.all()[0], email), "late reaction"), false);
  assert.equal(usage.cancelDeletedRoutes(routes.all(), email), false);
  const reloaded = new ImageUsageStore(usageFile);
  assert.equal(reloaded.cancelDeletedRoutes(routes.all(), email), false);
  assert.equal(reloaded.clientSnapshot(email).amountCents, 0);
});

test("rota apagada antes do joinha nunca gera consumo, inclusive com aprovação atrasada", (t) => {
  const { routes, usage, usageFile } = fixture(t);
  const route = create(routes);
  routes.recordDeletedMessage("msg-route");
  usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.decideValidatedRoute(validatedRouteUsagePayload(route, email), "late reaction"), false);
  assert.equal(new ImageUsageStore(usageFile).decideValidatedRoute(validatedRouteUsagePayload(route, email), "late reaction"), false);
  assert.equal(usage.snapshot().entries.length, 0);
});

test("rota antecipada apagada devolve exatamente um crédito por envio", (t) => {
  const { routes, usage, usageFile } = fixture(t);
  usage.addPrepaidRoutes(email, 10);
  create(routes, "route", { sentMessageIds: ["msg-route", "msg-second"], messages: ["Cliente J-29", "Cliente L-28"], totalCount: 2 });
  approve(routes, usage);
  assert.equal(usage.snapshot().clients[0].prepaidRoutesRemaining, 9);
  routes.recordDeletedMessage("msg-route"); usage.cancelDeletedRoutes(routes.all(), email);
  routes.recordDeletedMessage("msg-second"); usage.cancelDeletedRoutes(routes.all(), email);
  const reloaded = new ImageUsageStore(usageFile);
  reloaded.cancelDeletedRoutes(routes.all(), email);
  assert.equal(reloaded.snapshot().clients[0].prepaidRoutesRemaining, 10);
  assert.equal(routes.all()[0].deletionEvents.length, 2);
  assert.equal(reloaded.snapshot().entries[0].cancellation.prepaidRestored, true);
});

test("pagamento já recebido vira crédito e pode ser usado e devolvido sem duplicação", (t) => {
  const { routes, usage } = fixture(t);
  create(routes); approve(routes, usage);
  usage.registerPayment(email);
  routes.recordDeletedMessage("msg-route"); usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.snapshot().clients[0].creditBalanceCents, 500);
  usage.setRoutePrice(email, 700);
  create(routes, "next"); approve(routes, usage, "next");
  assert.equal(usage.clientSnapshot(email).amountCents, 200);
  assert.equal(usage.snapshot().clients[0].creditBalanceCents, 0);
  routes.recordDeletedMessage("msg-next"); usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.clientSnapshot(email).amountCents, 0);
  assert.equal(usage.snapshot().clients[0].creditBalanceCents, 500);
  usage.setRoutePrice(email, 500);
  create(routes, "final"); approve(routes, usage, "final");
  assert.equal(usage.snapshot().entries.find((entry) => entry.routeDispatchId === "final").paymentStatus, "paid");
  routes.recordDeletedMessage("msg-final"); usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.snapshot().clients[0].creditBalanceCents, 500);
});

test("não cancela outro cliente nem outra rota que compartilha a foto", (t) => {
  const { routes, usage } = fixture(t);
  usage.record({ id: "photo", clientEmail: email, messageId: "image", result: "detected" });
  create(routes, "route", { ocr: { analysisId: "photo", source: "test", processedAt: new Date().toISOString() } });
  create(routes, "sibling", { ocr: { analysisId: "photo", source: "test", processedAt: new Date().toISOString() } });
  approve(routes, usage); approve(routes, usage, "sibling");
  usage.decideValidatedRoute({ ...validatedRouteUsagePayload(routes.all().find((route) => route.id === "route"), "other@test.com"), analysisId: undefined }, "admin");
  routes.recordDeletedMessage("msg-route"); usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.clientSnapshot(email).amountCents, 500);
  assert.equal(usage.clientSnapshot("other@test.com").amountCents, 70);
  assert.equal(usage.snapshot().entries.find((entry) => entry.routeDispatchId === "sibling").decision, "billable");
  // Reusing a source photo after cancellation creates a new ledger entry.
  create(routes, "retry", { ocr: { analysisId: "photo", source: "test", processedAt: new Date().toISOString() } });
  approve(routes, usage, "retry");
  assert.equal(usage.clientSnapshot(email).amountCents, 1000);
});

test("mesma regra de exclusão vale para Target, manual e IA", (t) => {
  const { routes, usage } = fixture(t);
  for (const [id, trigger, ocr] of [["target", "automatic"], ["manual", "manual"], ["ia", "automatic", { analysisId: "photo-ia", source: "test", processedAt: new Date().toISOString() }]]) {
    create(routes, id, { trigger, ocr });
    assert.equal(routes.validate(id, "admin"), true);
    assert.equal(usage.decideValidatedRoute(validatedRouteUsagePayload(routes.all().find((route) => route.id === id), email), "admin"), true);
    routes.recordDeletedMessage(`msg-${id}`);
    usage.cancelDeletedRoutes(routes.all(), email);
  }
  assert.equal(usage.clientSnapshot(email).amountCents, 0);
  assert.equal(usage.snapshot().totals.billable, 0);
  assert.equal(routes.all().filter((route) => route.validated).length, 0);
  assert.equal(usage.snapshot().entries.filter((entry) => entry.cancellation).length, 3);
});

test("migra exclusões antigas sem perder histórico ou exigir explicação do cliente", (t) => {
  const { routes, routesFile } = fixture(t);
  create(routes); routes.validate("route", "admin"); routes.flush();
  const legacy = JSON.parse(fs.readFileSync(routesFile, "utf8"));
  legacy[0].deletedMessageIds = ["msg-route"];
  legacy[0].clientIncident = { kind: "message_deleted", required: true, message: "Old block", createdAt: legacy[0].updatedAt };
  fs.writeFileSync(routesFile, JSON.stringify(legacy));
  const migrated = new RouteStore(routesFile).all()[0];
  assert.equal(isRouteDeleted(migrated), true);
  assert.equal(migrated.validated, false);
  assert.equal(migrated.validationBeforeDeletion.validatedBy, "admin");
  assert.equal(RouteStore.isClientIncidentDue(migrated), false);
});

test("falha ao salvar cancelamento não perde nem duplica a devolução na nova tentativa", (t) => {
  const { routes, usage } = fixture(t);
  usage.addPrepaidRoutes(email, 10); create(routes); approve(routes, usage);
  routes.recordDeletedMessage("msg-route");
  const save = usage.save;
  usage.save = () => { throw new Error("disk unavailable"); };
  assert.throws(() => usage.cancelDeletedRoutes(routes.all(), email), /disk unavailable/);
  assert.equal(usage.snapshot().clients[0].prepaidRoutesRemaining, 9);
  assert.equal(usage.isDeletedRoute(email, "route"), false);
  usage.save = save;
  assert.equal(usage.cancelDeletedRoutes(routes.all(), email), true);
  assert.equal(usage.snapshot().clients[0].prepaidRoutesRemaining, 10);
  assert.equal(usage.cancelDeletedRoutes(routes.all(), email), false);
});

test("identificação tardia de quem apagou enriquece auditoria sem alterar data ou devolver de novo", (t) => {
  const { routes, usage } = fixture(t);
  usage.addPrepaidRoutes(email, 1); create(routes); approve(routes, usage);
  routes.recordDeletedMessage("msg-route", { detectedAt: "2026-10-29T10:00:00.000Z", source: "update" });
  usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(routes.recordDeletedMessage("msg-route", { actor: "client", actorJid: "5511999999999@s.whatsapp.net", source: "protocol" }), true);
  assert.equal(routes.all()[0].deletionEvents.length, 1);
  assert.equal(routes.all()[0].deletedAt, "2026-10-29T10:00:00.000Z");
  usage.cancelDeletedRoutes(routes.all(), email);
  assert.equal(usage.snapshot().clients[0].prepaidRoutesRemaining, 1);
});

function service(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-route-service-"));
  const bot = new BotService({ configPath: path.join(directory, "config.json"), routeStorePath: path.join(directory, "service-routes.json"),
    logStorePath: path.join(directory, "logs.json"), clientEmail: email });
  bot.emitSnapshot = () => undefined;
  bot.sock = { user: { id: "5511999999999:2@s.whatsapp.net", lid: "123456@lid" } };
  t.after(async () => { bot.routeStore.flush(); await bot.logger.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return bot;
}

test("revoke do WhatsApp via update cancela rota e identifica o cliente sem inventar autoria", (t) => {
  const bot = service(t);
  create(bot.routeStore); bot.routeStore.validate("route", "admin");
  const original = { id: "msg-route", remoteJid: "group@g.us", fromMe: true };
  bot.handleDeletedMessageUpdate({ key: original, update: { message: null, messageStubType: 2 } });
  assert.equal(bot.getRoutes()[0].validated, true, "null message alone is not a deletion");
  bot.handleDeletedMessageUpdate({ key: original, update: { message: null, messageStubType: 1, key: { fromMe: true } } });
  assert.equal(bot.getRoutes()[0].deletionEvents[0].actor, "client");
  create(bot.routeStore, "unknown");
  bot.handleDeletedMessageUpdate({ key: { ...original, id: "msg-unknown" }, update: { message: null, messageStubType: 1 } });
  assert.equal(bot.getRoutes()[0].deletionEvents[0].actor, "unknown");
  create(bot.routeStore, "admin-delete");
  bot.handleDeletedMessageNotice({ key: { remoteJid: "group@g.us", participant: "5522999999999@s.whatsapp.net" }, message: { protocolMessage: { type: 0, key: { id: "msg-admin-delete" } } } });
  assert.equal(bot.getRoutes()[0].deletionEvents[0].actor, "other");
  create(bot.routeStore, "history");
  bot.handleDeletedMessageNotice({ key: { id: "msg-history", remoteJid: "group@g.us", fromMe: true }, messageStubType: 1 });
  assert.equal(bot.getRoutes()[0].decisionStatus, "deleted");
  assert.equal(bot.getRoutes()[0].deletionEvents[0].actor, "unknown", "history tombstone only identifies the original author");
});

test("monitora exclusões mesmo com envio parado e alvo alterado; ignora conexão antiga", async (t) => {
  const bot = service(t);
  create(bot.routeStore);
  bot.monitoringEnabled = false;
  bot.preparedTargetJid = "new-group@g.us";
  const message = { key: { remoteJid: "group@g.us", fromMe: true }, message: { protocolMessage: { type: 0, key: { id: "msg-route" } } } };
  await bot.handleMessages([message], bot.activeConnectionId + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.getRoutes()[0].decisionStatus, "pending");
  await bot.handleMessages([message], bot.activeConnectionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.getRoutes()[0].decisionStatus, "deleted");
});

test("joinha recebido após a exclusão fica na auditoria sem revalidar, cobrar ou bloquear cliente", async (t) => {
  const bot = service(t);
  create(bot.routeStore); bot.routeStore.recordDeletedMessage("msg-route");
  bot.getReactionSenderIdentifiers = async () => ["5522999999999"];
  bot.isAdminPhoneIdentifier = () => true;
  bot.getLeaderNameFromIdentifiers = () => "Líder";
  let validations = 0, notifications = 0;
  bot.on("route-auto-validated", () => validations++);
  bot.sendSelfNotification = async () => { notifications++; };
  await bot.handleReactions([{ message: { reactionMessage: { key: { id: "msg-route" }, text: "👍", senderTimestampMs: Date.now() } } }]);
  await bot.handleReactions([{ message: { reactionMessage: { key: { id: "msg-route" }, text: "", senderTimestampMs: Date.now() } } }]);
  assert.equal(bot.getRoutes()[0].decisionStatus, "deleted");
  assert.equal(bot.getRoutes()[0].reactionsHistory.length, 2);
  assert.equal(validations, 0);
  assert.equal(notifications, 0);
  assert.equal(bot.hasPendingClientIncident(), false);
});
