const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BotProcessProxy } = require("../dist/bot/botProcessProxy.js");

function optionsFor(directory, email) {
  return {
    authDir: path.join(directory, "auth"),
    configPath: path.join(directory, "config.json"),
    routeStorePath: path.join(directory, "routes.json"),
    dispatchQueuePath: path.join(directory, "queue.json"),
    telemetryPath: path.join(directory, "telemetry.json"),
    logStorePath: path.join(directory, "logs.json"),
    romaneioDir: path.join(directory, "romaneio"),
    clientEmail: email,
    autoClearInvalidSession: true,
    deferSnapshotPayload: true
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condição do teste não foi atendida dentro do prazo.");
}

test("pedido de envio protege o processo antes de notificar a coordenação e libera com o snapshot final", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-critical-gate-"));
  const bot = new BotProcessProxy(optionsFor(directory, "fixture@teste.com"));
  try {
    await bot.ready(); let protectedAtRequest = false;
    bot.on("dispatch-gate-request", () => { protectedAtRequest = bot.isCriticalDispatchActive(); });
    bot.handleMessage({ type: "dispatch-gate-request", id: "fixture", clientEmail: "fixture@teste.com", groupKey: "fixture@g.us", eventDetectedAt: Date.now() });
    assert.equal(protectedAtRequest, true);
    await bot.setMessageCodes(["D-16"]);
    assert.equal(bot.isCriticalDispatchActive(), false);
  } finally { await bot.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cada cliente executa em processo próprio e mantém estado independente", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bot-process-isolation-"));
  const firstDirectory = path.join(root, "first");
  fs.mkdirSync(firstDirectory, { recursive: true });
  fs.writeFileSync(path.join(firstDirectory, "routes.json"), JSON.stringify([
    {
      id: "rota-preservada",
      clientEmail: "primeiro@teste.com",
      groupJid: "motoristas@g.us",
      groupName: "Motoristas",
      mode: "target",
      messages: ["Cliente F-14"],
      sentMessageIds: [],
      totalCount: 1,
      status: "sent",
      reactions: []
    }
  ]));
  const first = new BotProcessProxy(optionsFor(firstDirectory, "primeiro@teste.com"));
  const second = new BotProcessProxy(optionsFor(path.join(root, "second"), "segundo@teste.com"));

  try {
    await Promise.all([first.ready(), second.ready()]);

    assert.ok(first.getWorkerPid());
    assert.ok(second.getWorkerPid());
    assert.notEqual(first.getWorkerPid(), process.pid);
    assert.notEqual(second.getWorkerPid(), process.pid);
    assert.notEqual(first.getWorkerPid(), second.getWorkerPid());
    assert.equal(first.getRoutes()[0]?.id, "rota-preservada");

    await first.setMessageCodes(["F-14"]);

    assert.deepEqual(first.getSnapshot().config.codigosMensagensAlvo, ["F-14"]);
    assert.deepEqual(second.getSnapshot().config.codigosMensagensAlvo, []);
    assert.equal(first.getSnapshot().performanceMetrics.workerProcessId, first.getWorkerPid());
    assert.equal(second.getSnapshot().performanceMetrics.workerProcessId, second.getWorkerPid());

    const previousPid = first.getWorkerPid();
    process.kill(previousPid, "SIGKILL");
    await waitFor(() => first.getWorkerPid() && first.getWorkerPid() !== previousPid);
    await first.ready();
    await first.setMessageCodes(["G-2"]);

    assert.deepEqual(first.getSnapshot().config.codigosMensagensAlvo, ["G-2"]);
    assert.equal(first.getRoutes()[0]?.id, "rota-preservada");
    assert.equal(first.getSnapshot().performanceMetrics.workerRestartCount, 1);
  } finally {
    await Promise.all([first.shutdown(), second.shutdown()]);
    assert.equal(first.getWorkerPid(), undefined);
    assert.equal(second.getWorkerPid(), undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
