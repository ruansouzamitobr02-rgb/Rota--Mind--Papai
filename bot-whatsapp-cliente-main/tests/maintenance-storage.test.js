const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ImageUsageStore } = require("../dist/imageUsageStore");
const { RouteStore } = require("../dist/bot/routeStore");
const { OcrAnalysisHistoryStore } = require("../dist/bot/ocrAnalysisHistoryStore");
const { createEncryptedArchive, createPortableEncryptedArchive, recoverInterruptedCloudRestore,
  startCloudBackup, stopCloudBackup, runCloudBackup, prepareCloudRestore, getCloudBackupStatus } = require("../dist/services/cloudBackup");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const email = "cliente@maintenance.test";
function bill(store, id) {
  return store.decideValidatedRoute({ routeDispatchId: id, clientEmail: email, messageId: id, result: "detected" }, "admin");
}

test("ajuste do saldo acompanha novas rotas, exclusão, reinício, troca de email e pagamento", t => {
  const file = path.join(directory(t), "usage.json");
  let store = new ImageUsageStore(file);
  store.setRoutePrice(email, 500);
  bill(store, "first");
  store.setMonthlyTotal(email, 800);
  bill(store, "second");
  assert.equal(store.clientSnapshot(email).amountCents, 1300);
  store.cancelDeletedRoutes([{ id: "second", deletedAt: new Date().toISOString(), deletedMessageIds: ["second"] }], email);
  assert.equal(store.clientSnapshot(email).amountCents, 800);
  store = new ImageUsageStore(file);
  assert.equal(store.clientSnapshot(email).amountCents, 800);
  const next = "renamed@maintenance.test";
  store.renameClientEmail(email, next);
  assert.equal(store.clientSnapshot(next).amountCents, 800);
  assert.equal(store.clientSnapshot(email).amountCents, 0);
  store.registerPayment(next);
  assert.equal(new ImageUsageStore(file).clientSnapshot(next).amountCents, 0);
  store.decideValidatedRoute({ routeDispatchId: "third", clientEmail: next, messageId: "third", result: "detected" }, "admin");
  assert.equal(store.clientSnapshot(next).amountCents, 500);
});

test("falha ao salvar validação não consome antecipação; repetir cobra uma única vez", t => {
  const file = path.join(directory(t), "usage.json");
  const store = new ImageUsageStore(file);
  store.setPrepaidRoutes(email, 10);
  store.record({ id: "analysis", clientEmail: email, messageId: "image", result: "detected" });
  const original = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === file) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return original(source, destination);
    };
    assert.throws(() => bill(store, "first"), /disk full/);
  } finally { fs.renameSync = original; }
  assert.equal(store.snapshot().clients[0].prepaidRoutesRemaining, 10);
  assert.equal(store.get("analysis").decision, "pending");
  assert.equal(bill(store, "first"), true);
  assert.equal(bill(store, "first"), false);
  assert.equal(new ImageUsageStore(file).snapshot().clients[0].prepaidRoutesRemaining, 9);
});

test("pagamento recusado pelo disco mantém o saldo em aberto até gravar com sucesso", t => {
  const file = path.join(directory(t), "usage.json");
  const store = new ImageUsageStore(file);
  store.setRoutePrice(email, 500);
  bill(store, "first");
  const original = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === file) throw new Error("read only");
      return original(source, destination);
    };
    assert.throws(() => store.registerPayment(email), /read only/);
  } finally { fs.renameSync = original; }
  assert.equal(store.clientSnapshot(email).amountCents, 500);
  assert.equal(new ImageUsageStore(file).clientSnapshot(email).amountCents, 500);
  store.registerPayment(email);
  assert.equal(store.clientSnapshot(email).amountCents, 0);
});

test("financeiro rejeita registro nulo e recupera o arquivo válido sem apagar a cópia boa", t => {
  const file = path.join(directory(t), "usage.json");
  let store = new ImageUsageStore(file);
  store.setRoutePrice(email, 500);
  bill(store, "first");
  const valid = fs.readFileSync(file);
  fs.writeFileSync(`${file}.bak`, valid);
  const broken = JSON.parse(valid);
  broken.entries.push(null);
  fs.writeFileSync(file, JSON.stringify(broken));
  store = new ImageUsageStore(file);
  assert.equal(store.clientSnapshot(email).amountCents, 500);
  store.setDueDay(email, 15);
  assert.deepEqual(fs.readFileSync(`${file}.bak`), valid);
});

test("rotas recuperam backup válido e recusam substituir dois arquivos corrompidos por vazio", t => {
  const file = path.join(directory(t), "routes.json");
  fs.writeFileSync(file, "{broken");
  fs.writeFileSync(`${file}.bak`, JSON.stringify([{ id: "kept" }]));
  assert.equal(new RouteStore(file).all()[0].id, "kept");
  fs.writeFileSync(`${file}.bak`, "{also broken");
  assert.throws(() => new RouteStore(file).all(), /inválido|inv\S*lido/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("histórico OCR recuperado não sobrescreve sua cópia boa com o arquivo corrompido", async t => {
  const file = path.join(directory(t), "ocr.json");
  const valid = [{ status: "confirmed", analysisId: "first", options: [] }];
  fs.writeFileSync(file, "{broken");
  fs.writeFileSync(`${file}.bak`, JSON.stringify(valid));
  const store = new OcrAnalysisHistoryStore(file);
  assert.equal(store.all()[0].analysisId, "first");
  store.upsert({ status: "sent", analysisId: "second", options: [] });
  await store.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), valid);
  assert.equal(new OcrAnalysisHistoryStore(file).all().length, 2);
  fs.writeFileSync(file, "broken");
  fs.writeFileSync(`${file}.bak`, "broken");
  assert.throws(() => new OcrAnalysisHistoryStore(file));
});

test("journal inválido interrompe recuperação sem apagar dados ou declarar sucesso", t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, "clients.json"), "preserved");
  fs.writeFileSync(path.join(root, ".cloud-restore-journal.json"), "{broken");
  assert.throws(() => recoverInterruptedCloudRestore(root), /preservar/);
  assert.equal(fs.readFileSync(path.join(root, "clients.json"), "utf8"), "preserved");
});

test("erro no destino do backup rejeita a operação sem promessa solta ou processo travado", { timeout: 5000 }, async t => {
  const root = directory(t), source = path.join(root, "data"), output = path.join(root, "missing", "snapshot");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "config.json"), "important");
  await assert.rejects(createEncryptedArchive(source, output, crypto.randomBytes(32)), /ENOENT/);
  await assert.rejects(createPortableEncryptedArchive(source, output, "maintenance-password"), /ENOENT/);
  assert.equal(fs.readFileSync(path.join(source, "config.json"), "utf8"), "important");
});

test("falha ao criar temporário libera backup e restauração para nova tentativa", async t => {
  const root = directory(t);
  startCloudBackup(root, { R2_ENDPOINT: "https://backup.example.test", R2_BUCKET: "test",
    R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BACKUP_ENCRYPTION_KEY: "ab".repeat(32) });
  const original = fs.promises.mkdtemp;
  try {
    fs.promises.mkdtemp = async () => { throw Object.assign(new Error("temporary disk full"), { code: "ENOSPC" }); };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(runCloudBackup(root), /temporary disk full/);
      assert.equal(getCloudBackupStatus().running, false);
      assert.ok(getCloudBackupStatus().lastError, "a falha deve continuar visível ao administrador");
      await assert.rejects(prepareCloudRestore(root), /temporary disk full/);
    }
  } finally {
    fs.promises.mkdtemp = original;
    await stopCloudBackup();
  }
});
