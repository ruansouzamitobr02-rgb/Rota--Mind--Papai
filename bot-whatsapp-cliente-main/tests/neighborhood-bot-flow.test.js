const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BotService } = require("../dist/bot/connection");
const isolated = require("../dist/bot/ocrIsolated");

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function reading(rows) {
  const lines = rows.map((text, index) => {
    const words = text.split(" ").map((word, column) => ({ text: word, top: 40 + index * 40, left: column * 130, width: 100, height: 20, confidence: 95 }));
    return { text, words, top: 40 + index * 40, left: 0, width: 600, height: 20, confidence: 95 };
  });
  return { text: rows.join("\n"), lines, source: "fixture", variants: [0, 1].map((index) => ({ text: rows.join("\n"), lines: structuredClone(lines), source: `fixture-${index}` })) };
}

function createBot(t, email = "client@test.com") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neighborhood-flow-"));
  const bot = new BotService({
    clientEmail: email,
    configPath: path.join(directory, "config.json"),
    routeStorePath: path.join(directory, "routes.json"),
    dispatchQueuePath: path.join(directory, "queue.json"),
    telemetryPath: path.join(directory, "telemetry.json"),
    ocrAnalysisHistoryPath: path.join(directory, "ocr.json"),
    logStorePath: path.join(directory, "logs.json")
  });
  bot.configStore.save({ targetDispatchMode: "ocr", nomeEnvio: "Cliente", grupoAlvoJid: "group@g.us", rotasMonitoradasDetalhadas: [{ cidade: "Cidade", bairro: "Centro" }, { cidade: "Cidade", bairro: "Jardim Azul" }] });
  bot.sock = {};
  bot.status = "connected";
  bot.monitoringEnabled = true;
  bot.preparedTargetDispatchMode = "ocr";
  bot.latestRouteImageSequence = 1;
  bot.downloadRouteImage = async () => Buffer.from(email);
  bot.rebuildPreparedRelayMessages = () => undefined;
  bot.emitSnapshot = () => undefined;
  bot.dispatchPreparedOcrIfGroupOpen = async () => false;
  const states = [];
  bot.dispatchRaceEventReporter = (event) => states.push(event);
  t.after(async () => {
    bot.cancelPendingRouteImageBatch();
    await bot.logger.flush();
    await bot.ocrAnalysisHistoryStore.flush();
    bot.dispatchQueueStore.flush();
    bot.routeStore.flush();
    bot.telemetryStore.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { bot, states };
}

test("trava final bloqueia rota acima da condição individual salva", (t) => {
  const { bot } = createBot(t);
  bot.configStore.save({
    rotasMonitoradasDetalhadas: [
      { cidade: "", bairro: "Flamboyant", enabled: true, conditionMetric: "stops", conditionMax: 50 }
    ]
  });
  assert.match(bot.findOcrConditionViolation([
    { bairro: "Flamboyant", gaiola: "F-5", paradas: 57, pacotes: 118 }
  ]), /57 paradas.*máximo individual de 50/);
  assert.equal(bot.findOcrConditionViolation([
    { bairro: "Flamboyant", gaiola: "F-9", paradas: 50, pacotes: 119 }
  ]), undefined);
});

function mockReading(t, callback) {
  const original = isolated.readRouteImageOcrWithoutBlockingSocket;
  isolated.readRouteImageOcrWithoutBlockingSocket = callback;
  t.after(() => { isolated.readRouteImageOcrWithoutBlockingSocket = original; });
}

function batch(...ids) {
  return ids.map((messageId) => ({ messageId, msg: {}, groupJid: "group@g.us" }));
}

test("IA envia todos os bairros encontrados na ordem de preferencia, sem romaneio", async (t) => {
  const { bot, states } = createBot(t);
  // The lower preference is the first physical row. Configuration order wins.
  mockReading(t, async (_imagePath, options) => {
    assert.equal(options.preferCageCrop, false);
    assert.equal(options.fastFirst, true);
    return reading(["B-2 Cidade Jardim Azul", "A-1 Cidade Centro"]);
  });
  bot.romaneioStore = { routes() { throw new Error("No romaneio should be read"); }, getSettings() { throw new Error("No ranking should be used"); } };
  await bot.processRouteImageBatch(batch("image-1"), 1);
  assert.deepEqual(bot.pendingOcrMessages, ["Cliente A-1", "Cliente B-2"]);
  assert.equal(bot.ocrRouteSelection.options[0].bairro, "Centro");
  assert.equal(bot.ocrRouteSelection.options[1].bairro, "Jardim Azul");
  assert.equal(bot.ocrRouteSelection.status, "confirmed");
  assert.deepEqual(states.map((event) => event.state), ["processing", "ready"]);
});

test("IA respeita escolha de uma mensagem e nunca ultrapassa tres", async (t) => {
  const { bot } = createBot(t);
  bot.configStore.save({ ocrCageMessageLimit: 1 });
  mockReading(t, async () => reading(["A-1 Cidade Centro", "B-2 Cidade Jardim Azul"]));
  await bot.processRouteImageBatch(batch("limited-image"), 1);
  assert.deepEqual(bot.pendingOcrMessages, ["Cliente A-1"]);

  bot.configStore.save({ ocrCageMessageLimit: 99 });
  assert.equal(bot.configStore.load().ocrCageMessageLimit, 3);
});

test("painel recebe previa compacta enquanto OCR usa a imagem completa", async (t) => {
  const { bot } = createBot(t);
  const sharp = require("sharp");
  const source = await sharp({ create: { width: 1200, height: 500, channels: 3, background: "white" } }).png().toBuffer();
  bot.downloadRouteImage = async () => source;
  mockReading(t, async (_imagePath, options) => {
    assert.equal(options.preferCageCrop, false);
    assert.equal(options.fastFirst, false);
    return reading(["A-1 Cidade Centro"]);
  });
  await bot.processRouteImageBatch(batch("preview"), 1);
  assert.match(bot.ocrRouteSelection.imagePreviewUrl, /^data:image\/jpeg;base64,/);
});

test("bairro repetido usa a primeira gaiola e continua para os demais bairros", async (t) => {
  const { bot, states } = createBot(t);
  mockReading(t, async () => reading(["A-1 Cidade Centro", "B-2 Cidade Centro", "C-3 Cidade Jardim Azul"]));
  await bot.processRouteImageBatch(batch("ambiguous"), 1);
  assert.deepEqual(bot.pendingOcrMessages, ["Cliente A-1", "Cliente C-3"]);
  assert.equal(bot.ocrRouteSelection.status, "confirmed");
  assert.deepEqual(states.map((event) => event.state), ["processing", "ready"]);
});

test("parar durante download descarta a analise e nao prepara envio", async (t) => {
  const { bot, states } = createBot(t);
  const downloadStarted = deferred();
  const downloadRelease = deferred();
  bot.downloadRouteImage = async () => { downloadStarted.resolve(); await downloadRelease.promise; return Buffer.from("fixture"); };
  mockReading(t, async () => { throw new Error("OCR must not start after stop"); });
  const analysis = bot.processRouteImageBatch(batch("cancelled"), 1);
  await downloadStarted.promise;
  bot.disableMonitoring();
  downloadRelease.resolve();
  await analysis;
  assert.deepEqual(bot.pendingOcrMessages, []);
  assert.equal(bot.ocrRouteSelection.status, "error");
  assert.match(bot.ocrRouteSelection.message, /interrompida/);
  assert.deepEqual(states.map((event) => event.state), ["processing", "unavailable"]);
});

test("analise recebida sem conexao termina com erro em vez de ficar processando", async (t) => {
  const { bot } = createBot(t);
  bot.sock = undefined;
  await bot.processRouteImageBatch(batch("offline-before-ocr"), 1);
  assert.equal(bot.ocrRouteSelection.status, "error");
  assert.match(bot.ocrRouteSelection.message, /conexão mudou/);
  assert.deepEqual(bot.pendingOcrMessages, []);
});

test("parar enquanto a leitura OCR aguarda encerra a análise sem deixar o popup preso", async (t) => {
  const { bot } = createBot(t);
  const ocrStarted = deferred();
  const releaseOcr = deferred();
  mockReading(t, async () => { ocrStarted.resolve(); await releaseOcr.promise; return reading(["A-1 Cidade Centro"]); });
  const analysis = bot.processRouteImageBatch(batch("stop-during-ocr"), 1);
  await ocrStarted.promise;
  bot.disableMonitoring();
  releaseOcr.resolve();
  await analysis;
  assert.equal(bot.ocrRouteSelection.status, "error");
  assert.match(bot.ocrRouteSelection.message, /interrompida/);
  assert.deepEqual(bot.pendingOcrMessages, []);
});

test("dois clientes com a mesma imagem usam temporarios independentes", async (t) => {
  const first = createBot(t, "first@test.com");
  const second = createBot(t, "second@test.com");
  const secondReadingStarted = deferred();
  const releaseSecond = deferred();
  const paths = [];
  mockReading(t, async (imagePath) => {
    paths.push(imagePath);
    const contents = fs.readFileSync(imagePath, "utf8");
    if (contents === "first@test.com") await secondReadingStarted.promise;
    else { secondReadingStarted.resolve(); await releaseSecond.promise; }
    assert.equal(fs.readFileSync(imagePath, "utf8"), contents);
    return reading(["A-1 Cidade Centro"]);
  });
  const firstAnalysis = first.bot.processRouteImageBatch(batch("shared-id"), 1);
  const secondAnalysis = second.bot.processRouteImageBatch(batch("shared-id"), 1);
  await firstAnalysis;
  releaseSecond.resolve();
  await secondAnalysis;
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.every((file) => !fs.existsSync(file)));
  assert.deepEqual(first.bot.pendingOcrMessages, ["Cliente A-1"]);
  assert.deepEqual(second.bot.pendingOcrMessages, ["Cliente A-1"]);
});

test("ordem de chegada das fotos nao altera identidade do evento entre clientes", async (t) => {
  const { bot, states } = createBot(t);
  mockReading(t, async () => reading(["A-1 Cidade Centro"]));
  await bot.processRouteImageBatch(batch("image-b", "image-a"), 1);
  assert.equal(states[0].eventKey, "image-a+image-b");
  assert.equal(bot.lastOcrInsight.analysisId, "client@test.com:image-a+image-b");
});

test("IA pode operar sem bairros preferidos para oferecer revisao manual", async (t) => {
  const { bot } = createBot(t);
  bot.configStore.save({ rotasMonitoradasDetalhadas: [], rotasMonitoradas: [], ocrSelectionMode: "cages", ocrDesiredCages: ["A-1"] });
  assert.equal(bot.hasReadyMessages(), true);
});

test("rota sem preferencia segura aparece para confirmacao manual e corrige F-2u", async (t) => {
  const { bot, states } = createBot(t);
  bot.configStore.save({ rotasMonitoradasDetalhadas: [], rotasMonitoradas: [] });
  mockReading(t, async () => reading([
    "ROTA AT SPR CLUSTER BAIRRO",
    "F-2u AT20261002AJK75 116 Campos - Parque Aurora Parque Aurora"
  ]));

  await bot.processRouteImageBatch(batch("manual-fallback"), 1);

  assert.equal(bot.ocrRouteSelection.status, "ready");
  assert.equal(bot.ocrRouteSelection.options.length, 1);
  assert.equal(bot.ocrRouteSelection.options[0].gaiola, "F-24");
  assert.equal(bot.ocrRouteSelection.options[0].manualOnly, true);
  assert.deepEqual(bot.pendingOcrMessages, []);
  assert.deepEqual(states.map((event) => event.state), ["processing", "unavailable"]);

  await bot.confirmOcrRouteSelection([bot.ocrRouteSelection.options[0].id]);
  assert.equal(bot.ocrRouteSelection.status, "confirmed");
  assert.deepEqual(bot.pendingOcrMessages, ["Cliente F-24"]);
});

test("grupo aberto troca a analise para sucesso somente apos confirmacao do envio", async (t) => {
  const { bot } = createBot(t);
  delete bot.dispatchPreparedOcrIfGroupOpen;
  const analysisId = "client@test.com:success-image";
  bot.groupState = "open";
  bot.pendingOcrMessages = ["Cliente F-30"];
  bot.preparedMessages = ["Cliente F-30"];
  bot.lastOcrInsight = { analysisId, source: "fixture", code: "F-30", processedAt: new Date().toISOString() };
  bot.ocrRouteSelection = {
    status: "confirmed", analysisId, options: [], preparedMessages: ["Cliente F-30"], dispatchState: "waiting"
  };
  bot.routeStore.all = () => [{ ocr: { analysisId }, confirmedCount: 1 }];
  const sendCycle = deferred();
  bot.enviarMensagensRapidas = () => {
    bot.activeSendCycle = sendCycle.promise;
    return true;
  };

  assert.equal(await bot.dispatchPreparedOcrIfGroupOpen("manual"), true);
  assert.equal(bot.ocrRouteSelection.dispatchState, "sending");
  sendCycle.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
  assert.match(bot.ocrRouteSelection.message, /Cliente F-30/);
  assert.ok(bot.ocrRouteSelection.dispatchCompletedAt);
});
