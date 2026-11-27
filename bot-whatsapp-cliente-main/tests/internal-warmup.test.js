const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BotService } = require("../dist/bot/connection.js");

function createBot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-internal-warmup-"));
  const bot = new BotService({
    configPath: path.join(directory, "config.json"),
    routeStorePath: path.join(directory, "routes.json"),
    dispatchQueuePath: path.join(directory, "queue.json"),
    telemetryPath: path.join(directory, "telemetry.json"),
    logStorePath: path.join(directory, "logs.json"),
    clientEmail: "cliente@teste.com"
  });
  bot.configStore.save({
    grupoAlvoJid: "motoristas@g.us",
    grupoAlvoNome: "Motoristas",
    nomeEnvio: "Cliente",
    codigosMensagensAlvo: ["F-14"],
    alwaysWarmMode: false
  });
  bot.monitoringEnabled = true;
  bot.monitoringMode = "target";
  bot.status = "connected";
  bot.emitSnapshot = () => undefined;
  return { bot, directory };
}

test("pausar e terminar uma rota preserva preparação silenciosa sem rearmar ou enviar mensagens", async () => {
  const { bot, directory } = createBot();
  let preparations = 0, relays = 0;
  bot.sock = { relayMessage: async () => { relays++; } };
  bot.runWarmKeepAlive = async () => { preparations++; return true; };
  try {
    bot.disableMonitoring();
    assert.equal(bot.monitoringEnabled, false);
    assert.ok(bot.warmKeepAliveTimer);
    assert.equal(bot.warmKeepAliveIntervalMs, 30_000);
    assert.equal(relays, 0);
    bot.monitoringEnabled = true; bot.monitoringMode = "target"; bot.sendCycleId = 9;
    bot.stopMonitoringAfterTargetDispatch(9);
    assert.equal(bot.monitoringEnabled, false);
    assert.ok(bot.warmKeepAliveTimer);
    assert.equal(preparations, 2); assert.equal(relays, 0);
  } finally { bot.clearWarmKeepAliveTimer(); await bot.logger.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("parada aguarda a preparação antes de fechar a sessão persistente", async () => {
  const { bot, directory } = createBot(); const calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  bot.preparedSenderKeys = { close: async () => { calls.push("draining"); await pending; calls.push("drained"); } };
  bot.flushCreds = async () => { calls.push("creds"); };
  bot.flushAuthState = async () => { calls.push("flush"); };
  bot.closeAuthState = async () => { calls.push("close"); };
  try {
    const stopping = bot.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["draining"]);
    release(); await stopping;
    assert.deepEqual(calls, ["draining", "drained", "creds", "flush", "close"]);
  } finally { release(); await bot.logger.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("aquecimento interno continua ativo mesmo com monitoramento parado", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = false;
    const calls = { devices: 0, sessions: 0, senderKey: 0, relay: 0, presence: 0 };
    bot.sock = {
      authState: {
        keys: {
          get: async (type, ids) => {
            assert.equal(type, "sender-key-memory");
            assert.deepEqual(ids, ["motoristas@g.us"]);
            calls.senderKey += 1;
            return {};
          }
        }
      },
      getUSyncDevices: async (participants, useCache) => {
        assert.equal(useCache, false);
        calls.devices += 1;
        return participants.map((jid, index) => ({ jid: `${index}:${jid}` }));
      },
      assertSessions: async () => {
        calls.sessions += 1;
      },
      presenceSubscribe: async () => {
        calls.presence += 1;
      },
      sendPresenceUpdate: async () => {
        calls.presence += 1;
      },
      relayMessage: async () => {
        calls.relay += 1;
      }
    };
    bot.refreshGroupMetadata = async () => ({
      id: "motoristas@g.us",
      announce: true,
      participants: [
        { id: "1@s.whatsapp.net" },
        { id: "2@s.whatsapp.net" }
      ]
    });
    bot.ensurePreparedRelayMessages = () => true;

    assert.equal(await bot.runWarmKeepAlive("armado"), true);
    assert.equal(calls.devices, 1);
    assert.equal(calls.sessions, 1);
    assert.equal(calls.senderKey, 1);
    assert.equal(calls.presence, 2);
    assert.equal(calls.relay, 0);
    assert.equal(bot.internalWarmState, "ready");
    assert.equal(bot.getCurrentInternalWarmState(), "ready");
    assert.equal(bot.warmedGroupDeviceCount, 2);
    assert.ok(bot.lastSenderKeyWarmAt > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("aquecimento periódico não disputa recursos com análise de imagem", async () => {
  const { bot, directory } = createBot();
  try {
    let metadataReads = 0;
    let relayCalls = 0;
    bot.sock = {
      relayMessage: async () => {
        relayCalls += 1;
      }
    };
    bot.refreshGroupMetadata = async () => {
      metadataReads += 1;
      return { id: "motoristas@g.us", participants: [] };
    };
    bot.processingImageIds.add("imagem-em-analise");

    assert.equal(await bot.runWarmKeepAlive("timer"), false);
    assert.equal(metadataReads, 0);
    assert.equal(relayCalls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verificação quente fica silenciosa quando nenhum cache precisa ser renovado", async () => {
  const { bot, directory } = createBot();
  try {
    const now = Date.now();
    let snapshots = 0;
    let plans = 0;
    bot.sock = {};
    bot.groupMetadataCache.set("motoristas@g.us", {
      id: "motoristas@g.us",
      participants: []
    });
    bot.lastFullMetadataWarmAt = now;
    bot.lastActiveChatWarmAt = now;
    bot.lastGroupCryptoWarmAt = now;
    bot.lastSenderKeyWarmAt = now;
    bot.lastInternalWarmAt = new Date(now).toISOString();
    bot.internalWarmState = "ready";
    bot.emitSnapshot = () => {
      snapshots += 1;
    };
    bot.prepareSendPlan = () => {
      plans += 1;
      return true;
    };

    assert.equal(await bot.runWarmKeepAlive("timer"), true);
    assert.equal(snapshots, 0);
    assert.equal(plans, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("telemetria registra se o disparo começou aquecido ou frio", () => {
  const { bot, directory } = createBot();
  try {
    const now = Date.now();
    bot.internalWarmState = "ready";
    bot.lastInternalWarmAt = new Date(now - 250).toISOString();

    const warmTimeline = bot.createDispatchTimeline(now, now, "race", "group_update");
    assert.equal(warmTimeline.internalWarmState, "ready");
    assert.match(warmTimeline.events[1].detail, /aquecida/);

    bot.lastInternalWarmAt = new Date(now - (3 * 60 * 1000)).toISOString();
    const coldTimeline = bot.createDispatchTimeline(now, now, "race", "group_update");
    assert.equal(coldTimeline.internalWarmState, "cold");
    assert.match(coldTimeline.events[1].detail, /fria/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("profiler mede leituras e gravações de chaves durante o disparo", async () => {
  const { bot, directory } = createBot();
  try {
    const timeline = bot.createDispatchTimeline(Date.now(), Date.now(), "race", "group_update");
    bot.activeSignalProfileTimeline = timeline;
    const keys = bot.profileSignalKeyStore({
      get: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        return { id: { value: true } };
      },
      set: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    });

    await keys.get("session", ["id"]);
    await keys.set({ session: { id: { value: true } } });

    assert.equal(timeline.signalKeyReadOps, 1);
    assert.equal(timeline.signalKeyWriteOps, 1);
    assert.ok(timeline.signalKeyReadMs >= 1);
    assert.ok(timeline.signalKeyWriteMs >= 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
