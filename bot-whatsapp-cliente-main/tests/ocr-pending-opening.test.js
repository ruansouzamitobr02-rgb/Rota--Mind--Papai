const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BotService } = require("../dist/bot/connection");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function createPendingBot(t, mode = "manual") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-pending-open-"));
  const bot = new BotService({ clientEmail: "cliente@test.com", configPath: path.join(directory, "config.json"), routeStorePath: path.join(directory, "routes.json"), dispatchQueuePath: path.join(directory, "queue.json"), telemetryPath: path.join(directory, "telemetry.json"), logStorePath: path.join(directory, "logs.json"), ocrAnalysisHistoryPath: path.join(directory, "ocr.json") });
  bot.configStore.save({ grupoAlvoJid: "grupo@g.us", grupoAlvoNome: "Rotas", nomeEnvio: "Cliente", targetDispatchMode: "ocr" });
  bot.monitoringEnabled = true;
  bot.monitoringMode = "target";
  bot.status = "connected";
  bot.sock = {};
  bot.activeConnectionId = 5;
  bot.preparedTargetDispatchMode = "ocr";
  bot.preparedTargetJid = "grupo@g.us";
  bot.groupState = "closed";
  bot.grupoJaFechouDepoisDoInicio = false; // The close event was missed.
  const option = { id: "J-29", gaiola: "J-29", bairro: "Centro", regiao: "Campos - Tamandaré", rota: "Centro", paradas: 27, pacotes: 99, passedFilters: true, manualOnly: mode === "manual" };
  const analysisId = "cliente@test.com:foto-1";
  bot.lastOcrInsight = { analysisId, code: "J-29", analysisOptions: [option] };
  bot.ocrRouteSelection = { status: "ready", analysisId, options: [option] };
  bot.rebuildPreparedRelayMessages = (_jid, messages) => { bot.preparedRelayMessages = messages.map((text, i) => ({ key: { id: `msg-${i}` }, message: { conversation: text } })); };
  bot.applyOcrRouteSelection([option], mode);
  const sends = [];
  const ack = deferred();
  bot.sendAggressiveTargetSequence = async (jid, messages, cycleId, _detected, _started, trigger, timeline) => {
    sends.push({ jid, messages, trigger, timeline });
    await ack.promise;
    bot.updateRouteDispatch(cycleId, messages.length, messages.length, timeline, true);
    bot.stopMonitoringAfterTargetDispatch(cycleId);
  };
  bot.scheduleClosingWarmup = () => undefined;
  t.after(async () => {
    ack.resolve();
    await bot.activeSendCycle;
    bot.disableMonitoring();
    await bot.logger.flush();
    for (const store of [bot.routeStore, bot.dispatchQueueStore, bot.telemetryStore, bot.ocrAnalysisHistoryStore]) await store.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { bot, sends, ack, option };
}

test("rota confirmada dispara na abertura mesmo sem ter recebido o fechamento anterior", async t => {
  const { bot, sends, ack } = createPendingBot(t);
  const receivedAt = Date.now() - 12;
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5, receivedAt);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].trigger, "manual");
  assert.equal(sends[0].timeline.openingSignal, "group_update");
  assert.equal(Date.parse(sends[0].timeline.eventDetectedAt), receivedAt);
  assert.equal(bot.ocrRouteSelection.dispatchState, "sending");
  ack.resolve(); await bot.activeSendCycle; await tick();
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
  assert.equal(bot.routeStore.all()[0].confirmedCount, 1);
});

test("mensagem de abertura retoma a imagem confirmada sem esperar outro fechamento", async t => {
  const { bot, sends } = createPendingBot(t, "automatic");
  await bot.handleMessages([{ key: { remoteJid: "grupo@g.us", id: "aviso" }, message: { conversation: "Grupo aberto, podem mandar" } }], 5);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].timeline.openingSignal, "opening_message");
  assert.equal(bot.ocrRouteSelection.dispatchState, "sending");
});

test("reconexão com grupo aberto também atualiza o resultado da imagem", async t => {
  const { bot, sends, ack } = createPendingBot(t);
  bot.groupState = "open";
  assert.equal(bot.dispatchIfGroupAlreadyOpen("reconexão"), true);
  assert.equal(sends.length, 1);
  assert.equal(bot.ocrRouteSelection.dispatchState, "sending");
  ack.resolve(); await bot.activeSendCycle; await tick();
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
});

test("abertura repetida e mensagem de aviso não duplicam a rota nem cancelam o ciclo em envio", async t => {
  const { bot, sends, ack } = createPendingBot(t);
  bot.grupoJaFechouDepoisDoInicio = true;
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  const cycleId = bot.sendCycleId;
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  await bot.handleMessages([{ key: { remoteJid: "grupo@g.us" }, message: { conversation: "abriu" } }], 5);
  assert.equal(sends.length, 1);
  assert.equal(bot.sendCycleId, cycleId);
  ack.resolve(); await bot.activeSendCycle; await tick();
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
});

test("metadados atrasados de grupo fechado não sobrescrevem a abertura já recebida", async t => {
  const { bot, sends, ack } = createPendingBot(t);
  const metadata = deferred();
  bot.refreshGroupMetadata = () => metadata.promise;
  const checking = bot.dispatchPreparedOcrIfGroupOpen("manual");
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  metadata.resolve({ announce: true });
  await checking;
  assert.equal(bot.groupState, "open");
  assert.equal(sends.length, 1);
  ack.resolve(); await bot.activeSendCycle; await tick();
});

test("checagem de apoio detecta grupo aberto quando o WhatsApp omite o evento", async t => {
  const { bot, sends } = createPendingBot(t);
  bot.refreshGroupMetadata = async () => ({ announce: false });
  assert.equal(await bot.runWarmKeepAlive("timer"), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].timeline.openingSignal, "metadata_check");
});

test("imagem substituída durante consulta não usa metadados antigos para enviar outra rota", async t => {
  const { bot, sends } = createPendingBot(t);
  const metadata = deferred();
  bot.refreshGroupMetadata = () => metadata.promise;
  const checking = bot.dispatchPreparedOcrIfGroupOpen("manual");
  bot.lastOcrInsight = { analysisId: "foto-2" };
  bot.ocrRouteSelection = { status: "analyzing", analysisId: "foto-2", options: [] };
  bot.pendingOcrMessages = [];
  metadata.resolve({ announce: false });
  assert.equal(await checking, false);
  assert.equal(sends.length, 0);
});

test("não promete envio de confirmação manual quando o cliente já parou o monitoramento", async t => {
  const { bot } = createPendingBot(t);
  bot.ocrRouteSelection.status = "ready";
  bot.disableMonitoring();
  await assert.rejects(bot.confirmOcrRouteSelection(["J-29"]), /ative.*bot imagem/i);
});

test("cache de metadados também preserva um evento de abertura mais recente", async t => {
  const { bot } = createPendingBot(t);
  const metadata = deferred();
  bot.sock.groupMetadata = () => metadata.promise;
  const checking = bot.refreshGroupMetadata("grupo@g.us");
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  metadata.resolve({ id: "grupo@g.us", announce: true });
  assert.equal((await checking).announce, false);
  assert.equal(bot.groupMetadataCache.get("grupo@g.us").announce, false);
});

test("trava do fechamento anterior continua ativa no bot manual", async t => {
  const { bot, sends } = createPendingBot(t);
  bot.preparedTargetDispatchMode = "manual";
  bot.pendingOcrMessages = [];
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  assert.equal(sends.length, 0);
});

test("uma rota manual já aceita pela mesma análise não é enviada novamente", async t => {
  const { bot, sends, ack } = createPendingBot(t);
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  ack.resolve(); await bot.activeSendCycle; await tick();
  bot.monitoringEnabled = true;
  bot.ocrRouteSelection.dispatchState = "waiting";
  assert.equal(await bot.dispatchPreparedOcrIfGroupOpen("manual"), false);
  assert.equal(sends.length, 1);
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
});

test("parar enquanto os metadados carregam cancela a rota pendente", async t => {
  const { bot, sends } = createPendingBot(t);
  const metadata = deferred();
  bot.refreshGroupMetadata = () => metadata.promise;
  const checking = bot.dispatchPreparedOcrIfGroupOpen("manual");
  bot.disableMonitoring();
  metadata.resolve({ announce: false });
  assert.equal(await checking, false);
  assert.equal(sends.length, 0);
});

test("confirmação de envio atrasada atualiza a imagem sem antecipar falha", async t => {
  const { bot } = createPendingBot(t);
  let current;
  bot.sendAggressiveTargetSequence = async (_jid, _messages, cycleId, _detected, _started, _trigger, timeline) => {
    current = { cycleId, timeline };
    await tick();
    bot.updateRouteDispatch(cycleId, 0, 1, timeline, false);
  };
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  await bot.activeSendCycle; await tick();
  assert.equal(bot.ocrRouteSelection.dispatchState, "sending");
  current.timeline.finishedAt = new Date().toISOString();
  bot.updateRouteDispatch(current.cycleId, 1, 1, current.timeline, true);
  assert.equal(bot.ocrRouteSelection.dispatchState, "sent");
});

test("falha final de envio aparece como falha e não volta a aguardando", async t => {
  const { bot } = createPendingBot(t);
  bot.sendAggressiveTargetSequence = async (_jid, _messages, cycleId, _detected, _started, _trigger, timeline) => {
    await tick();
    bot.updateRouteDispatch(cycleId, 0, 1, timeline, true);
  };
  bot.handleGroupsUpdate([{ id: "grupo@g.us", announce: false }], 5);
  await bot.activeSendCycle; await tick();
  assert.equal(bot.ocrRouteSelection.dispatchState, "failed");
});

test("captura inicial do grupo funciona antes de o monitoramento ser armado", async t => {
  const { bot } = createPendingBot(t);
  bot.monitoringEnabled = false;
  bot.groupState = "unknown";
  bot.refreshGroupMetadata = async () => ({ announce: true });
  bot.prewarmActiveChat = async () => undefined;
  bot.prewarmGroupCrypto = async () => true;
  await bot.captureInitialGroupState();
  assert.equal(bot.groupState, "closed");
  assert.equal(bot.grupoJaFechouDepoisDoInicio, true);
});

test("captura inicial interrompida pelo cliente não aplica estado atrasado", async t => {
  const { bot } = createPendingBot(t);
  bot.groupState = "unknown";
  const metadata = deferred();
  bot.refreshGroupMetadata = () => metadata.promise;
  bot.prewarmActiveChat = async () => undefined;
  bot.prewarmGroupCrypto = async () => true;
  const checking = bot.captureInitialGroupState();
  bot.disableMonitoring();
  metadata.resolve({ announce: true });
  await checking;
  assert.equal(bot.groupState, "unknown");
});
