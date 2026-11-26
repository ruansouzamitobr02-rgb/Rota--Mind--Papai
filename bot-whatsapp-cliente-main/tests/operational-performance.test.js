const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveRuntimeCapacity, getOcrRuntimeBudget } = require("../dist/services/runtimeCapacity");
const { acquireGlobalOcrLock, acquireGlobalOcrCpu } = require("../dist/bot/ocrGlobalLock");
const { createPreprocessedImages } = require("../dist/bot/ocr");
const { waitForOcrPoolSignal } = require("../dist/bot/ocrPoolSignal");
const { BotService } = require("../dist/bot/connection");
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operation-performance-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test("fila compartilhada acorda pela liberação de arquivo sem aguardar o próximo polling", { skip: process.platform === "win32" && "Windows usa polling para evitar falha nativa do libuv" }, async t => {
  const dir = setup(t), notification = waitForOcrPoolSignal(dir, name => name === "slot.lock", 10000);
  let timeout;
  try {
    await fs.promises.writeFile(path.join(dir, "slot.lock"), "fixture");
    await Promise.race([notification, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error("Notificação de arquivo não chegou")), 1500); })]);
  } finally { clearTimeout(timeout); }
});

test("sistema sem notificações de arquivo mantém a alternativa por timer", async t => {
  const dir = setup(t);
  t.mock.method(fs, "watch", () => { throw Error("notifications unsupported"); });
  await waitForOcrPoolSignal(dir, () => true, 5);
});

test("orçamento usa quota real do container, inclusive CPU fracionada e memória limitada", () => {
  const host = { cpuCount: 64, memoryBytes: 64 * 1024 ** 3 };
  const render = resolveRuntimeCapacity({ ...host, cpuMax: "800000 100000", memoryMax: String(32 * 1024 ** 3) });
  assert.equal(render.cpuSlots, 8); assert.equal(render.memoryMb, 32768);
  const budget = getOcrRuntimeBudget({ OCR_GLOBAL_CONCURRENCY: "32", OCR_VARIANT_CONCURRENCY: "20" }, render);
  assert.equal(budget.imageConcurrency, 8); assert.equal(budget.cpuSlots, 8); assert.equal(budget.variantConcurrency, 5); assert.equal(budget.nativeThreads, 1);
  const small = resolveRuntimeCapacity({ ...host, cpuMax: "50000 100000", memoryMax: String(512 * 1024 ** 2) });
  assert.equal(small.cpuLimit, .5); assert.equal(small.cpuSlots, 1);
  assert.equal(getOcrRuntimeBudget({}, small).imageConcurrency, 1);
  assert.equal(getOcrRuntimeBudget({}, small).variantConcurrency, 1);
  assert.equal(resolveRuntimeCapacity({ ...host, quota: "200000", period: "100000" }).cpuSlots, 2);
  assert.equal(resolveRuntimeCapacity({ ...host, cpuMax: "max 100000" }).cpuSlots, 64);
  assert.equal(resolveRuntimeCapacity({ ...host, cpuMax: "invalid", memoryMax: "max" }).memoryMb, 65536);
});

test("leitores pesados compartilham limite de CPU sem deadlock com a fila de imagens", async t => {
  const dir = setup(t), env = { DATA_DIR: dir, OCR_GLOBAL_CONCURRENCY: "1" };
  const releaseImage = await acquireGlobalOcrLock(env);
  const slots = getOcrRuntimeBudget(env).cpuSlots, held = [];
  try {
    for (let i = 0; i < slots; i++) held.push(await acquireGlobalOcrCpu(env));
    let granted = false;
    const extra = acquireGlobalOcrCpu(env).then(release => { granted = true; return release; });
    await wait(100); assert.equal(granted, false, "abriu um leitor além das CPUs disponíveis");
    await held.pop()();
    const releaseExtra = await extra; assert.equal(granted, true); await releaseExtra();
  } finally { for (const release of held) await release(); await releaseImage(); }
  assert.equal(fs.readdirSync(dir).filter(file => file.endsWith(".lock")).length, 0);
});

test("pré-processamento sob demanda preserva a leitura inicial e deixa os fallbacks para quando necessários", async t => {
  const sharp = require("sharp"), dir = setup(t), file = path.join(dir, "table.png");
  await sharp({ create: { width: 900, height: 260, channels: 3, background: "white" } }).png().toFile(file);
  const variants = await createPreprocessedImages(file, false, "all", 5, true);
  const generated = [...new Set(variants.filter(item => item.generated).map(item => item.path))];
  t.after(() => { for (const file of generated) fs.rmSync(file, { force: true }); });
  assert.equal(generated.filter(file => fs.existsSync(file)).length, 0);
  await Promise.all(variants.slice(0, 2).map(item => item.prepare()));
  assert.equal(generated.filter(file => fs.existsSync(file)).length, 1, "gerou imagens que a primeira leitura não usa");
  assert.equal(variants[0].path, variants[1].path);
  await variants[2].prepare();
  assert.equal(generated.filter(file => fs.existsSync(file)).length, 2);
  for (const item of variants.slice(0, 3)) assert.equal((await sharp(item.path).metadata()).format, "png");
});

function botSetup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operation-bot-")), bot = new BotService({ clientEmail: "performance@test.com", configPath: path.join(dir, "config.json"), routeStorePath: path.join(dir, "routes.json"), dispatchQueuePath: path.join(dir, "queue.json"), telemetryPath: path.join(dir, "telemetry.json"), ocrAnalysisHistoryPath: path.join(dir, "analyses.json"), logStorePath: path.join(dir, "logs.json") });
  bot.emitSnapshot = () => undefined;
  t.after(async () => { bot.criticalDispatchInProgress = false; await wait(160); await bot.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return bot;
}

test("tarefa secundária agendada antes da abertura não invade o relay crítico", async t => {
  const bot = botSetup(t); let calls = 0;
  bot.deferSecondarySocketTask(() => { calls++; });
  bot.criticalDispatchInProgress = true;
  await tick(); await wait(70);
  assert.equal(calls, 0);
  bot.criticalDispatchInProgress = false;
  await wait(90); assert.equal(calls, 1);
});

test("prévia atrasada atualiza apenas sua análise e rota, sem trocar a foto da análise nova", async t => {
  const bot = botSetup(t), preview = "data:image/jpeg;base64,b2xk";
  const old = { analysisId: "old", status: "ready", options: [], processedAt: "2026-11-25T12:00:00Z" };
  const next = { analysisId: "next", status: "ready", options: [], imagePreviewUrl: "data:image/jpeg;base64,bmV3", processedAt: "2026-11-25T12:01:00Z" };
  bot.ocrAnalysisHistoryStore.upsert(old); bot.ocrAnalysisHistoryStore.upsert(next);
  bot.routeStore.create({ id: "old-route", groupJid: "test@g.us", messages: ["A-1"], sentMessageIds: [], confirmedCount: 1, totalCount: 1, status: "sent", clientEmail: "performance@test.com", mode: "target", ocr: { analysisId: "old" } });
  bot.latestRouteImageSequence = 2; bot.ocrRouteSelection = next;
  bot.publishRouteImagePreview("old", 1, preview);
  assert.equal(bot.ocrRouteSelection, next);
  assert.equal(bot.ocrAnalysisHistoryStore.all()[0].analysisId, "next");
  assert.equal(bot.getAnalysisPreview("old"), preview);
  assert.equal(bot.getAnalysisPreview("old-route"), preview);
  assert.equal(bot.routeStore.all()[0].confirmedCount, 1);
});

test("rota identificada chega ao envio antes de uma prévia lenta terminar", async t => {
  const bot = botSetup(t), previewReady = deferred(), dispatched = deferred();
  const engine = require("../dist/bot/ocrIsolated"), original = engine.readRouteImageOcrWithoutBlockingSocket;
  const text = "F-14 AT2026112500002 27 99 Campos Parque Rodoviário";
  let x = 10;
  const words = text.split(/\s+/).map(text => { const word = { text, left: x, top: 30, width: text.length * 10, height: 20, confidence: 95 }; x += word.width + 12; return word; });
  const reading = { text, source: "fixture", lines: [{ text, words, left: 10, top: 30, width: x - 10, height: 20, confidence: 95 }] };
  engine.readRouteImageOcrWithoutBlockingSocket = async () => ({ ...reading, variants: [reading, { ...reading, source: "fixture-second" }] });
  bot.configStore.save({ nomeEnvio: "Cliente", grupoAlvoJid: "test@g.us", targetDispatchMode: "ocr", rotasMonitoradasDetalhadas: [{ bairro: "Parque Rodoviário", enabled: true }], ocrMaxStops: 0, ocrMaxPackages: 0 });
  bot.monitoringEnabled = true; bot.monitoringMode = "target"; bot.preparedTargetDispatchMode = "ocr"; bot.latestRouteImageSequence = 1; bot.sock = {};
  bot.downloadRouteImage = async () => Buffer.from("fixture-image");
  bot.createRouteImagePreview = async () => { await previewReady.promise; return "data:image/jpeg;base64,cHJldmlldw=="; };
  bot.rebuildPreparedRelayMessages = () => undefined;
  bot.dispatchPreparedOcrIfGroupOpen = async () => { dispatched.resolve(); return true; };
  const analysis = bot.processRouteImageBatch([{ msg: {}, groupJid: "test@g.us", messageId: "fast-photo" }], 1);
  try {
    await Promise.race([dispatched.promise, wait(2000).then(() => { throw Error("O envio ficou preso esperando a prévia: " + bot.ocrRouteSelection.message); })]);
    assert.deepEqual(bot.pendingOcrMessages, ["Cliente F-14"]);
    assert.equal(bot.ocrRouteSelection.status, "confirmed");
    assert.equal(bot.ocrRouteSelection.imagePreviewUrl, undefined);
  } finally { previewReady.resolve(); await analysis; engine.readRouteImageOcrWithoutBlockingSocket = original; }
});
