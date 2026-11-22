const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { BotService } = require("../dist/bot/connection");
const { sendWorkerMessage } = require("../dist/bot/workerIpc");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function createBot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-bot-"));
  const bot = new BotService({ configPath: path.join(root, "config.json"), routeStorePath: path.join(root, "routes.json"), dispatchQueuePath: path.join(root, "queue.json"), telemetryPath: path.join(root, "telemetry.json"), logStorePath: path.join(root, "logs.json"), ocrAnalysisHistoryPath: path.join(root, "ocr.json") });
  bot.configStore.save({ grupoAlvoJid: "grupo@g.us", grupoTesteJid: "teste@g.us", nomeEnvio: "Cliente", codigosMensagensAlvo: ["A-1"] });
  bot.status = "connected"; bot.sock = {}; bot.groupState = "open";
  bot.hasReadyMessages = () => true; bot.prepareSendPlan = () => true;
  bot.startHealthCheck = () => undefined;
  bot.startWarmKeepAlive = async () => true;
  t.after(async () => { bot.disableMonitoring(); await bot.logger.flush(); await bot.ocrAnalysisHistoryStore.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return bot;
}

test("parar durante a preparação impede o bot de se armar novamente quando a consulta termina", async t => {
  const bot = createBot(t), pending = deferred();
  bot.captureInitialGroupState = () => pending.promise;
  const enabling = bot.enableMonitoring();
  bot.disableMonitoring(); pending.resolve();
  assert.equal(await enabling, false);
  assert.equal(bot.monitoringEnabled, false);
});

test("parar durante a resolução do grupo de teste cancela o início", async t => {
  const bot = createBot(t), pending = deferred();
  bot.resolveWarmupTarget = () => pending.promise;
  bot.captureInitialGroupState = async () => undefined;
  const enabling = bot.enableTestMonitoring();
  bot.disableMonitoring(); pending.resolve({ jid: "teste@g.us" });
  assert.equal(await enabling, false);
  assert.equal(bot.monitoringEnabled, false);
});

test("clique manual cancelado durante aquecimento não envia mensagem depois do Parar", async t => {
  const bot = createBot(t), pending = deferred(); let sends = 0, warm = false;
  bot.getCurrentInternalWarmState = () => warm ? "ready" : "cold";
  bot.runWarmKeepAlive = () => pending.promise;
  bot.refreshGroupMetadata = async () => ({ announce: false });
  bot.enviarMensagensRapidas = () => { sends++; return true; };
  const dispatch = bot.manualDispatch();
  bot.disableMonitoring(); warm = true; pending.resolve(true);
  assert.equal(await dispatch, false);
  assert.equal(sends, 0);
});

test("a conclusão de um disparo antigo não desarma um novo ciclo", async t => {
  const bot = createBot(t);
  bot.monitoringEnabled = true; bot.sendCycleId = 12;
  bot.stopMonitoringAfterTargetDispatch(11);
  assert.equal(bot.monitoringEnabled, true);
});

test("IPC trata canal fechado, exceção síncrona e erro assíncrono sem lançar nem duplicar erro", () => {
  const errors = [];
  assert.equal(sendWorkerMessage({ connected: false }, {}, error => errors.push(error.message)), false);
  assert.equal(sendWorkerMessage({ connected: true, send() { throw new Error("EPIPE"); } }, {}, error => errors.push(error.message)), false);
  assert.equal(sendWorkerMessage({ connected: true, send(_msg, callback) { callback(new Error("closed")); callback(new Error("closed")); return false; } }, {}, error => errors.push(error.message)), true);
  assert.deepEqual(errors, ["Canal do worker desconectado.", "EPIPE", "closed"]);
});

test("Parar no worker não fica preso na fila e cancela comandos antigos ainda não iniciados", async () => {
  const filename = path.resolve(__dirname, "../dist/bot/botWorker.js"), nativeRequire = createRequire(filename);
  const processMock = new EventEmitter(); Object.assign(processMock, { connected: true, pid: 123, exit() {}, disconnect() {} });
  const responses = []; processMock.send = (message, callback) => { responses.push(message); callback?.(null); return true; };
  const slow = deferred(), stopping = deferred(); let stopped = false, edits = 0;
  class FakeBot extends EventEmitter {
    getSnapshot() { return { status: "connected", config: {}, routeDispatches: [] }; }
    setDispatchGateHandlers() {} isCriticalDispatchActive() { return false; }
    async enableMonitoring() { await slow.promise; return true; }
    disableMonitoring() { stopped = true; return stopping.promise; }
    setMessageCodes() { edits++; }
  }
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    exports: {}, __dirname: path.dirname(filename), process: processMock, console, setTimeout, clearTimeout,
    require: name => name === "./connection" ? { BotService: FakeBot } : name === "./ocrIsolated" ? { shutdownIsolatedOcrWorker() {} } : name === "./panelSnapshot" ? { compactPanelSnapshot: s => s } : name === "os" ? { setPriority() {} } : nativeRequire(name)
  }, { filename });
  processMock.emit("message", { type: "init", options: {} }); await tick();
  processMock.emit("message", { type: "call", id: "slow", method: "enableMonitoring", args: [] }); await tick();
  processMock.emit("message", { type: "call", id: "stale", method: "setMessageCodes", args: [[]] });
  processMock.emit("message", { type: "call", id: "stop", method: "disableMonitoring", args: [] }); await tick();
  assert.equal(stopped, true);
  processMock.emit("message", { type: "call", id: "fresh", method: "setMessageCodes", args: [[]] });
  slow.resolve(); await tick(); await tick();
  assert.equal(edits, 0, "novos comandos aguardam o encerramento antigo");
  stopping.resolve(); await tick(); await tick();
  assert.ok(responses.some(r => r.id === "stop"));
  assert.equal(edits, 1); assert.match(responses.find(r => r.id === "stale").error, /cancelado/);
});

test("supervisor reinicia worker que não fica pronto e ignora respostas da instância anterior", async () => {
  const filename = path.resolve(__dirname, "../dist/bot/botProcessProxy.js"), nativeRequire = createRequire(filename);
  const children = [], timers = [];
  function fork() {
    const child = new EventEmitter(); Object.assign(child, { connected: true, exitCode: null, signalCode: null, pid: 100 + children.length });
    child.send = (message, callback) => { if (message.type === "shutdown") { child.exitCode = 0; child.emit("exit", 0); } callback?.(null); return true; };
    child.kill = signal => { child.signalCode = signal; child.connected = false; child.emit("exit", null, signal); return true; };
    children.push(child); return child;
  }
  const exports = {};
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    exports, __dirname: path.dirname(filename), process, console,
    setTimeout(callback, ms) { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    require: name => name === "child_process" ? { fork } : nativeRequire(name)
  }, { filename });
  const proxy = new exports.BotProcessProxy({});
  const rejected = assert.rejects(proxy.ready(), /30 segundos/);
  timers.find(timer => timer.ms === 30000).callback(); await rejected;
  assert.equal(children[0].signalCode, "SIGKILL");
  timers.find(timer => timer.ms === 1000).callback();
  children[1].emit("disconnect");
  assert.equal(children[1].signalCode, "SIGKILL");
  timers.find(timer => timer.ms === 2000).callback();
  children[0].emit("message", { type: "ready", snapshot: { status: "error" } });
  children[2].emit("message", { type: "ready", snapshot: { status: "connected" } });
  await proxy.ready(); assert.equal(proxy.getSnapshot().status, "connected");
  await proxy.shutdown();
});
