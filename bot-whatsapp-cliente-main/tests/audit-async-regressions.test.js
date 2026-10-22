const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const test = require("node:test");
const { subscribeSnapshots } = require("../dist/desktop/renderer/snapshotSubscription");
const { mergeUsageAmounts, parseMoneyInput } = require("../dist/desktop/renderer/admin/usageDrafts");
const { OcrAnalysisHistoryStore } = require("../dist/bot/ocrAnalysisHistoryStore");
const { ConfigStore } = require("../dist/bot/config");
const { DispatchQueueStore } = require("../dist/bot/dispatchQueue");
const { ImageUsageStore } = require("../dist/imageUsageStore");

test("snapshot HTTP antigo não substitui evento mais novo e cleanup cancela chamadas", async () => {
  let resolveLoad, receiveStream;
  let loads = 0;
  const received = [];
  const stop = subscribeSnapshots({
    intervalMs: 5, maxSilenceMs: 1000,
    load: () => { loads++; return new Promise((resolve) => { resolveLoad = resolve; }); },
    listen: (receive) => { receiveStream = receive; return () => {}; },
    receive: (value) => received.push(value)
  });
  receiveStream("new");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loads, 1);
  resolveLoad("old");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ["new"]);
  stop();
  // This request already completed; active-request cancellation is covered by snapshot-resume.test.js.
  receiveStream("after cleanup");
  assert.deepEqual(received, ["new"]);
});

test("atualização do consumo preserva edição ativa e atualiza campos não editados", () => {
  const snapshot = { entries: [{ id: "entry", amountCents: 70 }], clients: [{ clientEmail: "a@test.com", defaultAmountCents: 70, amountCents: 200 }] };
  const next = mergeUsageAmounts({ "total:a@test.com": "123,45", entry: "old", deleted: "stale" }, snapshot, new Set(["total:a@test.com"]));
  assert.equal(next["total:a@test.com"], "123,45");
  assert.equal(next.entry, "0,70");
  assert.equal(next.deleted, undefined);
  assert.equal(parseMoneyInput("1.234,56"), 123456);
  assert.equal(parseMoneyInput("12.50"), 1250);
  for (const value of ["abc", "-1", "Infinity", "1,234,56", ""]) assert.throws(() => parseMoneyInput(value));
});

test("gravações concorrentes preservam o histórico mais recente e configuração corrompida não é apagada", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-async-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.json");
  const store = new OcrAnalysisHistoryStore(historyPath);
  store.upsert({ status: "ready", analysisId: "old", options: [] });
  const first = store.flush();
  store.upsert({ status: "ready", analysisId: "new", options: [] });
  const second = store.flush();
  await Promise.all([first, second]);
  assert.deepEqual(new OcrAnalysisHistoryStore(historyPath).all().map((item) => item.analysisId), ["new", "old"]);
  for (const [name, load] of [["config.json", (file) => new ConfigStore(file).load()], ["queue.json", (file) => new DispatchQueueStore(file).all()]]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "{broken");
    assert.throws(() => load(file), /inválido/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  }
  const usage = new ImageUsageStore(path.join(directory, "usage.json"));
  usage.setMonthlyTotal("empty@test.com", 100, "2026-09");
  assert.equal(usage.snapshot("2026-09").totals.amountCents, 100);
  usage.renameClientEmail("empty@test.com", "renamed@test.com");
  assert.equal(usage.snapshot("2026-09").clients[0].clientEmail, "renamed@test.com");
});

test("queda do worker OCR liquida todos os pedidos e compartilha um único worker de recuperação", async () => {
  const filename = path.resolve(__dirname, "../dist/bot/ocrIsolated.js");
  const nativeRequire = createRequire(filename);
  const children = [];
  const isolatedExports = {};
  const fakeFork = () => {
    const child = new EventEmitter();
    child.connected = true;
    child.sent = [];
    child.send = (message, callback) => { child.sent.push(message); callback?.(); };
    child.kill = () => { child.connected = false; };
    children.push(child);
    return child;
  };
  const sandbox = {
    exports: isolatedExports,
    require: (name) => name === "child_process" ? { fork: fakeFork } : name === "./ocrCoordinator" ? {} : nativeRequire(name),
    __dirname: path.dirname(filename),
    process: { pid: process.pid, env: { OCR_ISOLATED_PROCESS: "true" } },
    setTimeout, clearTimeout, console
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  const first = isolatedExports.readRouteImageOcrWithoutBlockingSocket("first.png");
  const second = isolatedExports.readRouteImageOcrWithoutBlockingSocket("second.png");
  children[0].emit("error", new Error("EPIPE"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(children.length, 2);
  assert.equal(children[1].sent.length, 2);
  const result = { text: "A-1", lines: [], source: "fixture" };
  for (const message of children[1].sent) children[1].emit("message", { type: "result", id: message.id, result });
  assert.deepEqual(await Promise.all([first, second]), [result, result]);
  isolatedExports.shutdownIsolatedOcrWorker();
});
