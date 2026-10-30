const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compactPanelSnapshot } = require("../dist/bot/panelSnapshot");
const { createBoundedVersionLookup } = require("../dist/bot/versionLookup");
const { BotProcessProxy } = require("../dist/bot/botProcessProxy");

test("atualizações deixam de repetir fotos do histórico e preservam os dados originais", () => {
  const photo = "data:image/jpeg;base64," + Buffer.alloc(96 * 1024, 127).toString("base64");
  const analyses = Array.from({ length: 30 }, (_, index) => ({ analysisId: `analysis-${index}`, status: "ready", options: [], imagePreviewUrl: photo }));
  const snapshot = { ocrRouteSelection: analyses[0], ocrAnalysisHistory: analyses, routeDispatches: analyses.map((analysis, index) => ({ id: `route-${index}`, ocr: { analysisId: analysis.analysisId, imagePreviewUrl: photo } })) };
  const compact = compactPanelSnapshot(snapshot, "client@test.com");
  const before = Buffer.byteLength(JSON.stringify(snapshot));
  const after = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(after < before / 100, "deve reduzir mais de 99% do transporte nesse histórico de fotos");
  assert.equal(snapshot.ocrRouteSelection.imagePreviewUrl, photo);
  assert.equal(snapshot.ocrAnalysisHistory[10].imagePreviewUrl, photo);
  assert.match(compact.ocrAnalysisHistory[10].imagePreviewUrl, /^\/api\/analysis-preview\?/);
  assert.equal(new URL(compact.routeDispatches[10].ocr.imagePreviewUrl, "http://localhost").searchParams.get("id"), "route-10");
  console.log(`Fixture de 30 fotos: ${before} bytes -> ${after} bytes por atualização.`);
});

test("consulta de versão lenta libera a conexão e aproveita o resultado posterior", async () => {
  let finish;
  let calls = 0;
  const lookup = createBoundedVersionLookup(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, 5);
  assert.equal(await lookup(), undefined);
  assert.equal(calls, 1);
  finish([2, 3000, 123]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await lookup(), [2, 3000, 123]);
  assert.equal(calls, 1);
});

test("worker conserva fotos completas e entrega a imagem sob demanda sem reenviar o histórico", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-photo-"));
  const photo = "data:image/png;base64,aGVsbG8=";
  fs.writeFileSync(path.join(directory, "analyses.json"), JSON.stringify([{ analysisId: "old-photo", status: "ready", options: [], imagePreviewUrl: photo }]));
  const bot = new BotProcessProxy({ clientEmail: "photo@test.com", authDir: path.join(directory, "auth"), configPath: path.join(directory, "config.json"), routeStorePath: path.join(directory, "routes.json"), dispatchQueuePath: path.join(directory, "queue.json"), telemetryPath: path.join(directory, "telemetry.json"), ocrAnalysisHistoryPath: path.join(directory, "analyses.json"), logStorePath: path.join(directory, "logs.json"), romaneioDir: path.join(directory, "romaneio"), deferSnapshotPayload: true });
  t.after(async () => { await bot.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  await bot.ready();
  assert.match(bot.getSnapshot().ocrAnalysisHistory[0].imagePreviewUrl, /^\/api\/analysis-preview\?/);
  assert.equal(await bot.getAnalysisPreview("old-photo"), photo);
  assert.equal(await bot.getAnalysisPreview("missing"), undefined);
});
