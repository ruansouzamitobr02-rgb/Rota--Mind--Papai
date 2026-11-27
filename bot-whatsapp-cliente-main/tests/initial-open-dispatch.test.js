const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BotService } = require("../dist/bot/connection.js");

function createBot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-initial-open-"));
  const bot = new BotService({
    configPath: path.join(directory, "config.json"),
    routeStorePath: path.join(directory, "routes.json"),
    dispatchQueuePath: path.join(directory, "queue.json"),
    telemetryPath: path.join(directory, "telemetry.json"),
    logStorePath: path.join(directory, "logs.json"),
    clientEmail: "cliente@teste.com"
  });
  return { bot, directory };
}

test("ao armar com grupo aberto espera o próximo ciclo antes do automático", () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.status = "connected";
    bot.sock = {};
    bot.groupState = "open";
    bot.preparedTargetDispatchMode = "manual";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedMessages = ["Cliente F-14"];
    let called;
    bot.enviarMensagensRapidas = (...args) => {
      called = args;
      return true;
    };

    assert.equal(bot.dispatchIfGroupAlreadyOpen("armado"), false);
    assert.equal(called, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disparo manual aquece o grupo antes de usar o relay quando estava frio", async () => {
  const { bot, directory } = createBot();
  try {
    bot.configStore.save({
      grupoAlvoJid: "motoristas@g.us",
      grupoAlvoNome: "Motoristas",
      nomeEnvio: "Cliente",
      codigosMensagensAlvo: ["F-14"]
    });
    bot.status = "connected";
    bot.sock = {};
    let warmCalls = 0;
    let dispatched = false;
    bot.runWarmKeepAlive = async () => {
      warmCalls += 1;
      bot.internalWarmState = "ready";
      bot.lastInternalWarmAt = new Date().toISOString();
      return true;
    };
    bot.refreshGroupMetadata = async () => ({ announce: false });
    bot.prepareSendPlan = () => true;
    bot.enviarMensagensRapidas = () => {
      dispatched = true;
      return true;
    };

    assert.equal(await bot.manualDispatch(), true);
    assert.equal(warmCalls, 1);
    assert.equal(dispatched, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bot imagem por gaiolas envia a fila completa sem limitar a duas mensagens", async () => {
  const { bot, directory } = createBot();
  try {
    const messages = Array.from({ length: 25 }, (_, index) => `Cliente G-${index + 1}`);
    let received = [];
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.preparedTargetDispatchMode = "ocr";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedMessages = messages;
    bot.rebuildPreparedRelayMessages = () => undefined;
    bot.sendAggressiveTargetSequence = (_jid, outgoing) => {
      received = outgoing;
      return Promise.resolve();
    };
    bot.enqueueDispatch = () => undefined;
    bot.registerRouteDispatch = () => "route-test";
    bot.attachRaceTrackingRoute = () => undefined;
    bot.markQueuedDispatchSending = () => undefined;

    assert.equal(bot.enviarMensagensRapidas(1, "automatic", Date.now(), "image_ready"), true);
    assert.deepEqual(received, messages);
    await bot.activeSendCycle;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("seleção automática prepara uma mensagem para cada gaiola marcada encontrada", () => {
  const { bot, directory } = createBot();
  try {
    bot.configStore.save({
      nomeEnvio: "Cliente",
      ocrSelectionMode: "cages",
      ocrDesiredCages: ["C-25", "C-30", "B-29"]
    });
    bot.ocrRouteSelection = { status: "ready", options: [] };
    const selected = ["C-25", "C-30", "B-29"].map((gaiola, index) => ({
      id: `option-${index}`,
      rank: index + 1,
      rota: `Rota ${index + 1}`,
      gaiola,
      bairro: "Centro",
      distanciaKm: 10,
      pacotes: 20,
      paradas: 15,
      passedFilters: true,
      reasons: [],
      score: 100,
      romaneioMatch: true
    }));

    bot.applyOcrRouteSelection(selected, "automatic");

    assert.deepEqual(bot.pendingOcrMessages, ["Cliente C-25", "Cliente C-30", "Cliente B-29"]);
    assert.deepEqual(bot.preparedMessages, ["Cliente C-25", "Cliente C-30", "Cliente B-29"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("aviso pessoal usa o próprio número conectado sem atrasar o grupo", async () => {
  const { bot, directory } = createBot();
  try {
    const sent = [];
    bot.status = "connected";
    bot.sock = {
      user: { id: "5511999999999:12@s.whatsapp.net" },
      sendMessage: async (jid, content) => sent.push({ jid, content })
    };

    assert.equal(await bot.sendSelfNotification("🚀 DISPARO REALIZADO"), true);
    assert.deepEqual(sent, [{
      jid: "5511999999999@s.whatsapp.net",
      content: { text: "🚀 DISPARO REALIZADO" }
    }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("primeira mensagem não espera a adaptação aplicada à segunda", async () => {
  const { bot, directory } = createBot();
  try {
    const calls = [];
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 7;
    bot.adaptiveOpeningSettleMs = 60;
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        calls.push({ id: options.messageId, at: Date.now() });
      }
    };
    bot.preparedRelayMessages = [
      { key: { id: "first" }, message: { conversation: "Cliente A-1" } },
      { key: { id: "second" }, message: { conversation: "Cliente A-2" } }
    ];
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const startedAt = Date.now();
    const timeline = {
      eventDetectedAt: new Date(startedAt).toISOString(),
      sendStartedAt: new Date(startedAt).toISOString(),
      detectionDelayMs: 0,
      timeoutUsed: false,
      retryUsed: false,
      notAcceptableCount: 0,
      mode: "race",
      events: []
    };
    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1", "Cliente A-2"],
      7,
      startedAt,
      startedAt,
      "automatic",
      timeline
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "first");

    await dispatch;
    assert.equal(calls.length, 2);
    assert.equal(calls[1].id, "second");
    assert.ok(calls[1].at - calls[0].at >= 60);
    assert.ok(timeline.firstAckMs < 60);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pré-aquece dispositivos e sessões do grupo sem repetir enquanto o cache está fresco", async () => {
  const { bot, directory } = createBot();
  try {
    const calls = { devices: 0, sessions: 0 };
    bot.sock = {
      getUSyncDevices: async (participants, useCache) => {
        calls.devices += 1;
        assert.equal(useCache, true);
        return participants.map((jid, index) => ({ jid: `${index}:${jid}` }));
      },
      assertSessions: async (devices, force) => {
        calls.sessions += 1;
        assert.equal(devices.length, 3);
        assert.equal(force, false);
        return true;
      }
    };
    const metadata = {
      id: "motoristas@g.us",
      participants: [
        { id: "1@s.whatsapp.net" },
        { id: "2@s.whatsapp.net" },
        { id: "3@s.whatsapp.net" }
      ]
    };

    assert.equal(await bot.prewarmGroupCrypto(metadata), true);
    assert.equal(await bot.prewarmGroupCrypto(metadata), true);
    assert.deepEqual(calls, { devices: 1, sessions: 1 });
    assert.equal(bot.warmedGroupDeviceCount, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mudança de participantes invalida metadados e refaz o aquecimento criptográfico", async () => {
  const { bot, directory } = createBot();
  try {
    const groupJid = "motoristas@g.us";
    let warmed = 0;
    bot.activeConnectionId = 4;
    bot.monitoringEnabled = true;
    bot.preparedTargetJid = groupJid;
    bot.sock = {};
    bot.groupMetadataCache.set(groupJid, { id: groupJid, participants: [] });
    bot.warmedGroupParticipantSignature = "antiga";
    bot.lastGroupCryptoWarmAt = Date.now();
    bot.warmedGroupDeviceCount = 10;
    bot.deferSecondarySocketTask = (task) => task();
    bot.runWarmKeepAlive = async (reason) => {
      assert.equal(reason, "timer");
      warmed += 1;
      return true;
    };

    bot.handleGroupParticipantsUpdate({ id: groupJid, action: "add" }, 4);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bot.groupMetadataCache.has(groupJid), false);
    assert.equal(bot.warmedGroupParticipantSignature, "");
    assert.equal(bot.warmedGroupDeviceCount, 0);
    assert.equal(bot.internalWarmState, "cold");
    assert.equal(warmed, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("segunda mensagem só usa o socket depois do ACK da primeira", async () => {
  const { bot, directory } = createBot();
  try {
    const calls = [];
    let releaseFirst;
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 11;
    bot.adaptiveOpeningSettleMs = 0;
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        calls.push(options.messageId);
        if (options.messageId === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
      }
    };
    bot.preparedRelayMessages = [
      { key: { id: "first" }, message: { conversation: "Cliente A-1" } },
      { key: { id: "second" }, message: { conversation: "Cliente A-2" } }
    ];
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1", "Cliente A-2"],
      11
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["first"]);

    releaseFirst();
    await dispatch;
    assert.deepEqual(calls, ["first", "second"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("primeiro relay começa antes de construir o envelope da segunda mensagem", async () => {
  const { bot, directory } = createBot();
  try {
    const order = [];
    let releaseFirst;
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 12;
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        order.push(`relay:${options.messageId}`);
        if (options.messageId === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
      }
    };
    bot.preparedRelayMessages = [
      { key: { id: "first" }, message: { conversation: "Cliente A-1" } }
    ];
    bot.buildRelayTextMessage = (_sock, _jid, message) => {
      order.push(`build:${message}`);
      return { key: { id: "second" }, message: { conversation: message } };
    };
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1", "Cliente A-2"],
      12
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(order, ["relay:first", "build:Cliente A-2"]);
    releaseFirst();
    await dispatch;
    assert.deepEqual(order, ["relay:first", "build:Cliente A-2", "relay:second"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("faixa especulativa libera a segunda mensagem sem esperar o ACK da primeira", async () => {
  const { bot, directory } = createBot();
  try {
    const calls = [];
    let releaseFirst;
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 13;
    bot.shouldUseSpeculativeSecondLane = () => true;
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        calls.push(options.messageId);
        if (options.messageId === "first") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
      }
    };
    bot.preparedRelayMessages = [
      { key: { id: "first" }, message: { conversation: "Cliente A-1" } },
      { key: { id: "second" }, message: { conversation: "Cliente A-2" } }
    ];
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const timeline = bot.createDispatchTimeline(Date.now(), Date.now(), "race", "group_update");
    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1", "Cliente A-2"],
      13,
      Date.now(),
      Date.now(),
      "automatic",
      timeline
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(timeline.secondLaneMode, "speculative");
    releaseFirst();
    await dispatch;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("prioridade de cliente atrasa discretamente o primeiro relay do grupo alvo", async () => {
  const { bot, directory } = createBot();
  try {
    const calls = [];
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 131;
    bot.dispatchPriorityLevel = 1;
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        calls.push({ id: options.messageId, at: Date.now() });
      }
    };
    bot.preparedRelayMessages = [
      { key: { id: "first" }, message: { conversation: "Cliente A-1" } }
    ];
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const startedAt = Date.now();
    const timeline = bot.createDispatchTimeline(startedAt, startedAt, "race", "group_update");
    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1"],
      131,
      startedAt,
      startedAt,
      "automatic",
      timeline
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);

    await dispatch;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].at - startedAt >= 390);
    assert.equal(timeline.dispatchPriority.level, 1);
    assert.equal(timeline.priorityDelayMs, 400);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("prioridade aceita atraso exato configurado pelo administrador", () => {
  const { bot, directory } = createBot();
  try {
    bot.setDispatchPriorityDelayMs(850);
    assert.deepEqual(bot.getDispatchPriorityProfile(), { level: 1, delayMs: 850 });
    bot.setDispatchPriorityDelayMs(0);
    assert.deepEqual(bot.getDispatchPriorityProfile(), { level: 0, delayMs: 0 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordenação central impede relay até o servidor autorizar e confirma o vencedor", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 132;
    const relays = [];
    const confirmations = [];
    let releaseGate;
    bot.setDispatchGateHandlers(
      () => new Promise((resolve) => { releaseGate = resolve; }),
      (token, email) => confirmations.push({ token, email })
    );
    bot.sock = {
      relayMessage: async (_jid, _message, options) => {
        relays.push(options.messageId);
      }
    };
    bot.preparedRelayMessages = [{ key: { id: "first" }, message: { conversation: "Cliente A-1" } }];
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const startedAt = Date.now();
    const timeline = bot.createDispatchTimeline(startedAt, startedAt, "race", "group_update");
    const dispatch = bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1"],
      132,
      startedAt,
      startedAt,
      "automatic",
      timeline
    );

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(relays, []);
    releaseGate({ token: "gate-132", waitedMs: 25 });
    await dispatch;
    assert.deepEqual(relays, ["first"]);
    assert.deepEqual(confirmations, [{ token: "gate-132", email: "cliente@teste.com" }]);
    assert.equal(timeline.priorityDelayMs, 25, "deve registrar o tempo informado pelo coordenador sem aplicar outra espera");
    assert.ok(timeline.coordinationWaitMs >= 0);
    assert.equal(timeline.events.some((event) => /coordena/i.test(event.label)), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("falha definitiva do primeiro relay avisa a contingência central", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.sendCycleId = 133;
    bot.preparedTargetDispatchMode = "ocr";
    bot.lastOcrInsight = { analysisId: "cliente@teste.com:IMAGEM-133" };
    const failures = [];
    let gateRequest;
    bot.setDispatchGateHandlers(
      async (request) => {
        gateRequest = request;
        return { token: "gate-133", waitedMs: 0 };
      },
      () => undefined,
      (token, email) => failures.push({ token, email })
    );
    bot.sock = {
      relayMessage: async () => { throw new Error("relay indisponível"); }
    };
    bot.preparedRelayMessages = [{ key: { id: "failed-first" }, message: { conversation: "Cliente A-1" } }];
    bot.retryTargetMessageAfterFailure = async () => false;
    bot.updateRouteDispatch = () => undefined;
    bot.recordDispatchMetrics = () => undefined;
    bot.stopMonitoringAfterTargetDispatch = () => undefined;
    bot.emitSnapshot = () => undefined;
    bot.addStatusEvent = () => undefined;

    const startedAt = Date.now();
    await bot.sendAggressiveTargetSequence(
      "motoristas@g.us",
      ["Cliente A-1"],
      133,
      startedAt,
      startedAt,
      "automatic",
      bot.createDispatchTimeline(startedAt, startedAt, "race", "image_ready")
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(gateRequest.eventKey, "IMAGEM-133");
    assert.deepEqual(failures, [{ token: "gate-133", email: "cliente@teste.com" }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("conexão aquecida libera a faixa paralela sem histórico de três disparos", () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringMode = "target";
    bot.status = "connected";
    bot.internalWarmState = "ready";
    bot.lastInternalWarmAt = new Date().toISOString();
    assert.equal(bot.shouldUseSpeculativeSecondLane("automatic"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disparo reconstrói envelope com ID e timestamp novos", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedMessages = ["Cliente A-1"];
    bot.preparedNuclearMode = false;
    let rebuilds = 0;
    bot.rebuildPreparedRelayMessages = () => {
      rebuilds += 1;
      bot.preparedRelayMessages = [{ key: { id: "fresh" }, message: { conversation: "Cliente A-1" } }];
    };
    bot.sendAggressiveTargetSequence = async () => undefined;
    bot.enqueueDispatch = () => undefined;
    bot.registerRouteDispatch = () => "route-fresh";
    bot.markQueuedDispatchSending = () => undefined;

    assert.equal(bot.enviarMensagensRapidas(1, "automatic", Date.now(), "group_update"), true);
    assert.equal(rebuilds, 1);
    await bot.activeSendCycle;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("403 no pré-aquecimento não derruba o processo", async () => {
  const { bot, directory } = createBot();
  try {
    bot.prewarmConnection = async () => {
      const error = new Error("forbidden");
      error.data = 403;
      throw error;
    };
    bot.emitSnapshot = () => undefined;

    assert.equal(await bot.prewarmConnectionSafely("teste"), false);
    assert.equal(bot.groupState, "unknown");
    assert.equal(bot.currentUserInTargetGroup, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("servidor pode adiar snapshot pesado e emitir apenas sinal leve", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-light-snapshot-"));
  const bot = new BotService({
    configPath: path.join(directory, "config.json"),
    routeStorePath: path.join(directory, "routes.json"),
    dispatchQueuePath: path.join(directory, "queue.json"),
    telemetryPath: path.join(directory, "telemetry.json"),
    logStorePath: path.join(directory, "logs.json"),
    deferSnapshotPayload: true
  });
  try {
    let payload = "not-called";
    bot.on("snapshot", (next) => {
      payload = next;
    });
    bot.getSnapshot = () => {
      throw new Error("snapshot pesado não deveria ser montado neste ciclo");
    };

    bot.emitSnapshot();
    assert.equal(payload, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("evento oficial mede latência desde a entrada no callback do Baileys", () => {
  const { bot, directory } = createBot();
  try {
    bot.activeConnectionId = 3;
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedTargetDispatchMode = "manual";
    bot.grupoJaFechouDepoisDoInicio = true;
    const receivedAt = Date.now() - 25;
    let called;
    bot.enviarMensagensRapidas = (...args) => {
      called = args;
      return true;
    };

    bot.handleGroupsUpdate([{ id: "motoristas@g.us", announce: false }], 3, receivedAt);
    assert.equal(called[2], receivedAt);
    assert.equal(called[3], "group_update");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("grupo aberto aguarda a leitura segura quando o modo é imagem", () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.groupState = "open";
    bot.preparedTargetDispatchMode = "ocr";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedMessages = [];
    bot.pendingOcrMessages = [];
    let calls = 0;
    bot.enviarMensagensRapidas = () => {
      calls += 1;
      return true;
    };

    assert.equal(bot.dispatchIfGroupAlreadyOpen("armado"), false);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("imagem nova dispara assim que fica pronta com o grupo aberto", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.status = "connected";
    bot.sock = {};
    bot.groupState = "open";
    bot.preparedTargetDispatchMode = "ocr";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.pendingOcrMessages = ["Cliente B-1"];
    bot.lastOcrInsight = { analysisId: "cliente@teste.com:imagem-nova" };
    bot.getActiveMonitoringGroup = () => ({ jid: "motoristas@g.us", label: "grupo alvo" });
    let called;
    bot.enviarMensagensRapidas = (...args) => {
      called = args;
      return true;
    };

    assert.equal(await bot.dispatchPreparedOcrIfGroupOpen("automatic"), true);
    assert.equal(called[1], "automatic");
    assert.equal(called[3], "image_ready");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ciclo ativo é liberado mesmo se outro gatilho incrementar o contador", async () => {
  const { bot, directory } = createBot();
  try {
    bot.monitoringEnabled = true;
    bot.monitoringMode = "target";
    bot.preparedTargetJid = "motoristas@g.us";
    bot.preparedMessages = ["Cliente B-1"];
    bot.preparedNuclearMode = false;
    bot.ensurePreparedRelayMessages = () => undefined;
    bot.sendAggressiveTargetSequence = async () => undefined;
    bot.enqueueDispatch = () => undefined;
    bot.registerRouteDispatch = () => "route-1";
    bot.markQueuedDispatchSending = () => undefined;

    assert.equal(bot.enviarMensagensRapidas(1, "automatic", Date.now(), "group_update"), true);
    const active = bot.activeSendCycle;
    bot.sendCycleId = 2;
    await active;

    assert.equal(bot.activeSendCycle, undefined);
    assert.equal(bot.criticalDispatchInProgress, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
