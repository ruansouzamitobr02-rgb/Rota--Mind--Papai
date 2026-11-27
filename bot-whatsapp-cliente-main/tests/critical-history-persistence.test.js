const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { RouteStore } = require("../dist/bot/routeStore");
const { TelemetryStore } = require("../dist/bot/telemetryStore");
const { OcrAnalysisHistoryStore } = require("../dist/bot/ocrAnalysisHistoryStore");
const { DispatchQueueStore } = require("../dist/bot/dispatchQueue");
const { BotService } = require("../dist/bot/connection");
const route = id => ({ id, clientEmail: "fixture@test.com", groupJid: "fixture@g.us", groupName: "Fixture", mode: "target", trigger: "automatic", messages: ["Cliente D-16"], sentMessageIds: [`message-${id}`], confirmedCount: 0, totalCount: 1, status: "sending" });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "critical-history-"));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 10, 26) });
  t.after(() => { t.mock.timers.reset(); fs.rmSync(directory, { recursive: true, force: true }); });
  return name => path.join(directory, `${name}.json`);
}

for (const kind of ["routes", "telemetry"]) {
  function create(file, busy) {
    const store = kind === "routes" ? new RouteStore(file, busy) : new TelemetryStore(file, busy);
    const add = id => kind === "routes" ? store.create(route(id)) : store.record({ clientEmail: "fixture@test.com", mode: "target", confirmed: 1, total: 1 });
    return { store, add };
  }

  test(`${kind}: histórico permanece em memória durante o relay e salva ao liberar a pista`, t => {
    const file = fixture(t)(kind); let busy = true;
    const { store, add } = create(file, () => busy);
    add("one"); t.mock.timers.tick(500);
    assert.equal(fs.existsSync(file), false); assert.equal(store.all().length, 1);
    busy = false; t.mock.timers.tick(25);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
  });

  test(`${kind}: novas alterações não prorrogam o limite de dois segundos`, t => {
    const file = fixture(t)(kind);
    const { add } = create(file, () => true);
    add("initial");
    for (let i = 0; i < 7; i++) { t.mock.timers.tick(250); add(`change-${i}`); }
    assert.equal(fs.existsSync(file), false);
    t.mock.timers.tick(250);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 8);
  });

  test(`${kind}: flush explícito salva mesmo durante a corrida`, t => {
    const file = fixture(t)(kind);
    const { store, add } = create(file, () => true);
    add("shutdown"); store.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
    t.mock.timers.tick(2500);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
  });
}

test("fila de recuperação continua persistindo enquanto histórico pesado aguarda", t => {
  const file = fixture(t), history = new RouteStore(file("routes"), () => true), queue = new DispatchQueueStore(file("queue"));
  history.create(route("one"));
  const pending = queue.enqueue({ id: "one", cycleId: 1, clientEmail: "fixture@test.com", jid: "fixture@g.us", messages: ["Cliente D-16"], trigger: "automatic", mode: "target" });
  queue.markSending(pending.id, "one"); t.mock.timers.tick(300);
  assert.equal(fs.existsSync(file("routes")), false);
  const restored = new DispatchQueueStore(file("queue"));
  assert.equal(restored.pending()[0].status, "sending");
  assert.equal(restored.hasRecentEquivalent("fixture@g.us", ["Cliente D-16"]), true);
  history.flush();
});

test("prévia OCR não grava durante o relay e mantém cópia independente dos dados", async t => {
  const file = fixture(t)("ocr"); let busy = true;
  const store = new OcrAnalysisHistoryStore(file, () => busy);
  const selection = { status: "confirmed", analysisId: "image", options: [{ id: "D-16", gaiola: "D-16", bairro: "Centro", passedFilters: true }], selectedOptionIds: ["D-16"], imagePreviewUrl: `data:image/png;base64,${"a".repeat(512 * 1024)}` };
  store.upsert(selection); selection.options[0].bairro = "changed"; selection.selectedOptionIds.push("other");
  t.mock.timers.tick(500); assert.equal(fs.existsSync(file), false);
  assert.equal(store.all()[0].options[0].bairro, "Centro"); assert.deepEqual(store.all()[0].selectedOptionIds, ["D-16"]);
  busy = false; t.mock.timers.tick(25); await store.saveChain;
  const restored = new OcrAnalysisHistoryStore(file);
  assert.equal(restored.all()[0].imagePreviewUrl, selection.imagePreviewUrl);
  assert.equal(restored.all()[0].options[0].bairro, "Centro");
});

test("prévia OCR não fica sem salvar se o relay continuar lento além do limite", async t => {
  const file = fixture(t)("ocr"), store = new OcrAnalysisHistoryStore(file, () => true);
  store.upsert({ status: "confirmed", analysisId: "image", options: [] });
  t.mock.timers.tick(2000); await store.saveChain;
  assert.equal(new OcrAnalysisHistoryStore(file).all()[0].analysisId, "image");
});

test("flush explícito preserva ordenação das prévias mesmo com salvamento anterior em andamento", async t => {
  const file = fixture(t)("ocr"), store = new OcrAnalysisHistoryStore(file, () => true);
  store.upsert({ status: "confirmed", analysisId: "image", options: [], message: "first" });
  const first = store.flush();
  store.upsert({ status: "confirmed", analysisId: "image", options: [], message: "latest" });
  const latest = store.flush(); await Promise.all([first, latest]);
  assert.equal(new OcrAnalysisHistoryStore(file).all()[0].message, "latest");
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))[0].message, "first");
});

test("disparo real do serviço mantém a fila gravada e libera histórico depois do retorno do relay", async t => {
  const file = fixture(t);
  const bot = new BotService({ configPath: file("config"), routeStorePath: file("routes"), dispatchQueuePath: file("queue"), telemetryPath: file("telemetry"), ocrAnalysisHistoryPath: file("ocr"), logStorePath: file("logs"), clientEmail: "fixture@test.com" });
  let release; const ack = new Promise(resolve => { release = resolve; }); let calls = 0;
  bot.configStore.save({ grupoAlvoJid: "fixture@g.us", grupoAlvoNome: "Fixture", nomeEnvio: "Cliente", codigosMensagensAlvo: ["D-16"] });
  bot.status = "connected"; bot.monitoringEnabled = true; bot.preparedTargetJid = "fixture@g.us";
  bot.preparedMessages = ["Cliente D-16"]; bot.sendCycleId = 1;
  bot.emitSnapshot = () => undefined; bot.keepIdlePreparationAlive = () => undefined;
  bot.rebuildPreparedRelayMessages = () => { bot.preparedRelayMessages = [{ key: { id: "first-message" }, message: { conversation: "Cliente D-16" } }]; };
  bot.sock = { relayMessage: async () => { calls++; await ack; } };
  try {
    assert.equal(bot.enviarMensagensRapidas(1, "automatic", Date.now(), "group_update"), true);
    assert.equal(calls, 1);
    bot.ocrAnalysisHistoryStore.upsert({ status: "confirmed", analysisId: "image", options: [] });
    await Promise.resolve(); t.mock.timers.tick(300);
    assert.equal(bot.criticalDispatchInProgress, true);
    assert.equal(fs.existsSync(file("routes")), false); assert.equal(fs.existsSync(file("ocr")), false);
    assert.equal(new DispatchQueueStore(file("queue")).pending()[0].status, "sending");
    release(); await bot.activeSendCycle; await Promise.resolve();
    t.mock.timers.tick(300); await bot.ocrAnalysisHistoryStore.saveChain;
    assert.equal(new RouteStore(file("routes")).all()[0].confirmedCount, 1);
    assert.equal(new OcrAnalysisHistoryStore(file("ocr")).all()[0].analysisId, "image");
  } finally {
    release(); await bot.activeSendCycle; await bot.logger.flush();
    for (const store of [bot.routeStore, bot.dispatchQueueStore, bot.telemetryStore, bot.ocrAnalysisHistoryStore]) await store.flush();
  }
});
