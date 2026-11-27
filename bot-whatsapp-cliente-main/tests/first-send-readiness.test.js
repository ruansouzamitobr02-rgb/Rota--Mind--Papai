const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { BotService } = require("../dist/bot/connection");
const group = "fixture@g.us", tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-first-send-readiness-"));
  const file = name => path.join(directory, `${name}.json`);
  const bot = new BotService({ configPath: file("config"), routeStorePath: file("routes"), dispatchQueuePath: file("queue"), telemetryPath: file("telemetry"), ocrAnalysisHistoryPath: file("ocr"), logStorePath: file("logs"), clientEmail: "fixture@test.com" });
  bot.configStore.save({ grupoAlvoJid: group, grupoAlvoNome: "Fixture", nomeEnvio: "Cliente", codigosMensagensAlvo: ["D-16"] });
  bot.status = "connected"; bot.groupState = "closed"; bot.monitoringEnabled = true;
  bot.preparedTargetJid = group; bot.preparedMessages = ["Cliente D-16"];
  bot.grupoJaFechouDepoisDoInicio = true;
  bot.emitSnapshot = () => undefined;
  bot.sock = { ws: new EventEmitter() };
  t.after(async () => { bot.clearWarmKeepAliveTimer(); bot.removeSocketActivityListener?.(); await bot.logger.flush(); for (const store of [bot.routeStore, bot.dispatchQueueStore, bot.telemetryStore, bot.ocrAnalysisHistoryStore]) await store.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return bot;
}

test("armar, fechamento e timer simultâneos compartilham uma única preparação", async t => {
  const bot = fixture(t), response = deferred(); let queries = 0, crypto = 0, presence = 0;
  bot.sock.groupMetadata = async () => { queries++; return response.promise; };
  bot.sock.getUSyncDevices = async () => [];
  bot.sock.assertSessions = async () => undefined;
  bot.prewarmGroupCrypto = async () => { crypto++; return true; };
  bot.prewarmActiveChat = async () => { presence++; };
  bot.prepareSendPlan = () => true;
  const first = bot.runWarmKeepAlive("armado"), second = bot.runWarmKeepAlive("fechamento"), third = bot.runWarmKeepAlive("timer");
  assert.equal(first, second); assert.equal(first, third); assert.equal(queries, 1);
  response.resolve({ id: group, announce: true, participants: [] });
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(crypto, 1); assert.equal(presence, 1);
});

test("presença lenta não segura a preparação das chaves nem o gatilho de abertura", async t => {
  const bot = fixture(t), presence = deferred(), ack = deferred(); let prepared = false, completed = false, sends = 0;
  bot.sock.groupMetadata = async () => ({ id: group, announce: true, participants: [] });
  bot.sock.getUSyncDevices = async () => []; bot.sock.assertSessions = async () => undefined;
  bot.prewarmGroupCrypto = async () => true;
  bot.prewarmActiveChat = () => presence.promise;
  bot.prepareSenderKeyFanout = async () => { prepared = true; return 1; };
  bot.prepareSendPlan = () => true;
  bot.rebuildPreparedRelayMessages = () => { bot.preparedRelayMessages = [{ key: { id: "fixture-first" }, message: { conversation: "Cliente D-16" } }]; };
  bot.sock.relayMessage = async () => { sends++; await ack.promise; };
  const warming = bot.runWarmKeepAlive("armado").then(result => { completed = true; return result; });
  await tick();
  assert.equal(prepared, true); assert.equal(completed, false);
  bot.handleGroupsUpdate([{ id: group, announce: false }], bot.activeConnectionId);
  assert.equal(sends, 1);
  presence.resolve(); await warming;
  ack.resolve(); await bot.activeSendCycle; await tick();
});

test("mudança de grupo durante preparação não republica o estado aquecido antigo", async t => {
  const bot = fixture(t), response = deferred();
  bot.sock.groupMetadata = () => response.promise;
  const warming = bot.runWarmKeepAlive("armado");
  bot.invalidateInternalWarmState(true);
  response.resolve({ id: group, announce: true, participants: [] });
  assert.equal(await warming, false);
  assert.equal(bot.internalWarmState, "cold"); assert.equal(bot.lastFullMetadataWarmAt, 0);
  assert.equal(bot.groupMetadataCache.has(group), false);
});

test("consultas concorrentes do mesmo grupo usam uma requisição e não reaproveitam a de outro socket", async t => {
  const bot = fixture(t), old = deferred(); let queries = 0;
  bot.sock.groupMetadata = () => { queries++; return old.promise; };
  const a = bot.refreshGroupMetadata(group), b = bot.refreshGroupMetadata(group);
  assert.equal(a, b); assert.equal(queries, 1);
  const latest = { id: group, announce: false, subject: "New connection" };
  bot.sock = { groupMetadata: async () => latest };
  assert.equal(await bot.refreshGroupMetadata(group), latest);
  old.resolve({ id: group, announce: true });
  assert.equal(await a, undefined); assert.equal(bot.groupMetadataCache.get(group), latest);
});

test("verificações concorrentes do socket compartilham ping e ignoram resposta de conexão substituída", async t => {
  const bot = fixture(t), response = deferred(); let pings = 0;
  bot.sock.generateMessageTag = () => "probe";
  bot.sock.query = (_node, timeout) => { assert.equal(timeout, 1500); pings++; return response.promise; };
  const a = bot.measureSocketRtt(), b = bot.measureSocketRtt();
  assert.equal(a, b); assert.equal(pings, 1);
  bot.sock = {}; bot.lastSocketRttMs = 42;
  response.reject(new Error("old connection")); await a;
  assert.equal(bot.socketProbeFailures, 0); assert.equal(bot.lastSocketRttMs, 42);
});

test("três falhas com conexão silenciosa recuperam o socket sem apagar rota ou desarmar", async t => {
  const bot = fixture(t); let recoveries = 0;
  bot.pendingOcrMessages = ["Cliente D-16"];
  bot.lastSocketActivityAt = Date.now() - 60_000;
  bot.sock.generateMessageTag = () => "probe";
  bot.sock.query = async () => { throw new Error("no response"); };
  bot.sock.end = error => { assert.equal(error.output.statusCode, 408); recoveries++; };
  await bot.measureSocketRtt(); await bot.measureSocketRtt();
  assert.equal(recoveries, 0);
  await bot.measureSocketRtt(); await bot.measureSocketRtt();
  assert.equal(recoveries, 1); assert.equal(bot.socketRecoveryCount, 1);
  assert.deepEqual(bot.pendingOcrMessages, ["Cliente D-16"]); assert.equal(bot.monitoringEnabled, true);
});

test("tráfego recente cancela suspeita de conexão travada; uma resposta saudável limpa falhas", async t => {
  const bot = fixture(t); let recoveries = 0;
  bot.lastSocketActivityAt = Date.now() - 60_000; bot.socketProbeFailures = 2;
  bot.trackSocketActivity(bot.sock); bot.sock.ws.emit("message", Buffer.from("fixture"));
  assert.equal(bot.socketProbeFailures, 0);
  bot.sock.generateMessageTag = () => "probe";
  bot.sock.query = async () => { throw new Error("no response"); };
  bot.sock.end = () => { recoveries++; };
  await bot.measureSocketRtt(); await bot.measureSocketRtt(); await bot.measureSocketRtt();
  assert.equal(recoveries, 0);
  bot.sock.query = async () => ({});
  await bot.measureSocketRtt(); assert.equal(bot.socketProbeFailures, 0);
});

test("recuperação preventiva preserva a corrida, leitura de imagem e fechamento recente", async t => {
  for (const change of [bot => { bot.criticalDispatchInProgress = true; }, bot => { bot.activeSendCycle = Promise.resolve(); }, bot => { bot.groupState = "open"; }, bot => { bot.processingImageIds.add("image"); }, bot => { bot.ocrRouteSelection.status = "analyzing"; }, bot => { bot.lastOpeningSignalAt = Date.now(); }, bot => { bot.stopping = true; }]) {
    const bot = fixture(t); let recoveries = 0;
    bot.lastSocketActivityAt = Date.now() - 60_000; bot.socketProbeFailures = 3;
    bot.sock.end = () => { recoveries++; }; change(bot);
    bot.recoverUnresponsiveSocket(bot.sock); assert.equal(recoveries, 0);
  }
});

test("respostas antigas de memória e dispositivos não aquecem o grupo depois da invalidação", async t => {
  const bot = fixture(t), memory = deferred(), devices = deferred();
  bot.sock.authState = { keys: { get: () => memory.promise } };
  bot.sock.getUSyncDevices = () => devices.promise; bot.sock.assertSessions = async () => undefined;
  const sender = bot.prewarmGroupSenderKeyMemory(group);
  const crypto = bot.prewarmGroupCrypto({ id: group, participants: [{ id: "123@s.whatsapp.net" }] }, true);
  bot.invalidateInternalWarmState(true);
  memory.resolve({}); devices.resolve([{ jid: "123:1@s.whatsapp.net" }]);
  assert.deepEqual(await Promise.all([sender, crypto]), [false, false]);
  assert.equal(bot.lastSenderKeyWarmAt, 0); assert.deepEqual(bot.warmedGroupDeviceJids, []);
});

test("consulta de dispositivos que termina na abertura cede as sessões ao primeiro relay", async t => {
  const bot = fixture(t), devices = deferred(); let assertions = 0;
  bot.sock.getUSyncDevices = () => devices.promise;
  bot.sock.assertSessions = async () => { assertions++; };
  const warming = bot.prewarmGroupCrypto({ id: group, participants: [{ id: "123@s.whatsapp.net" }] }, true);
  bot.criticalDispatchInProgress = true;
  devices.resolve([{ jid: "123:1@s.whatsapp.net" }]);
  assert.equal(await warming, false); assert.equal(assertions, 0);
});

test("conexão nova aquece sessões sem esperar descoberta pendente da conexão antiga", async t => {
  const bot = fixture(t), devices = deferred(); let oldAssertions = 0, newAssertions = 0;
  bot.sock.getUSyncDevices = () => devices.promise;
  bot.sock.assertSessions = async () => { oldAssertions++; };
  const metadata = { id: group, participants: [{ id: "123@s.whatsapp.net" }] };
  const old = bot.prewarmGroupCrypto(metadata, true);
  bot.sock = { getUSyncDevices: async () => [{ jid: "123:2@s.whatsapp.net" }], assertSessions: async () => { newAssertions++; } };
  assert.equal(await bot.prewarmGroupCrypto(metadata, true), true);
  assert.equal(newAssertions, 1);
  devices.resolve([{ jid: "123:1@s.whatsapp.net" }]);
  assert.equal(await old, false); assert.equal(oldAssertions, 0);
  assert.deepEqual(bot.warmedGroupDeviceJids, ["123:2@s.whatsapp.net"]);
});

test("recuperação trata rejeição assíncrona do encerramento sem derrubar o worker", async t => {
  const bot = fixture(t);
  bot.lastSocketActivityAt = Date.now() - 60_000; bot.socketProbeFailures = 3;
  bot.sock.end = async () => { throw new Error("fixture close failure"); };
  bot.recoverUnresponsiveSocket(bot.sock); await tick();
  assert.ok(bot.logger.all().some(entry => entry.message.includes("fixture close failure")));
});
