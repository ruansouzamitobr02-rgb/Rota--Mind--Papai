const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");

const { createEncryptedArchive, createPortableEncryptedArchive, extractEncryptedArchive, recoverInterruptedCloudRestore } = require("../dist/services/cloudBackup.js");

test("backup criptografado compacta os dados persistentes e exclui cache descartavel", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-backup-test-"));
  const dataDir = path.join(temp, "data");
  const output = path.join(temp, "snapshot.rmbak");
  fs.mkdirSync(path.join(dataDir, "users", "cliente", "auth_info"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "ocr-result-cache"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "users", "cliente", "config.json"), "preferencias importantes");
  const Database = require("better-sqlite3");
  const sessionDb = new Database(path.join(dataDir, "users", "cliente", "auth_info", "auth.sqlite"));
  sessionDb.pragma("journal_mode = WAL");
  sessionDb.exec("CREATE TABLE session_data (value TEXT); INSERT INTO session_data VALUES ('sessao whatsapp')");
  fs.writeFileSync(path.join(dataDir, "ocr-result-cache", "cache.json"), "cache descartavel");

  try {
    const key = crypto.randomBytes(32);
    await createEncryptedArchive(dataDir, output, key);
    const encrypted = fs.readFileSync(output);
    assert.equal(encrypted.subarray(0, 8).toString("ascii"), "RMDBK001");
    const iv = encrypted.subarray(8, 20);
    const tag = encrypted.subarray(-16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(encrypted.subarray(20, -16)), decipher.final()]);
    const archive = gunzipSync(compressed).toString("latin1");
    assert.match(archive, /users[\\/]cliente[\\/]config\.json/);
    assert.match(archive, /preferencias importantes/);
    assert.match(archive, /auth\.sqlite/);
    assert.match(archive, /sessao whatsapp/);
    assert.doesNotMatch(archive, /cache descartavel/);

    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 0xff;
    const invalid = crypto.createDecipheriv("aes-256-gcm", key, corrupted.subarray(8, 20));
    invalid.setAuthTag(corrupted.subarray(-16));
    assert.throws(() => {
      invalid.update(corrupted.subarray(20, -16));
      invalid.final();
    });
  } finally {
    sessionDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("restaura arquivo criptografado validando conteÃºdo e autenticaÃ§Ã£o", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-restore-test-"));
  const source = path.join(temp, "source");
  const output = path.join(temp, "snapshot.rmbak");
  const destination = path.join(temp, "restored");
  fs.mkdirSync(path.join(source, "users"), { recursive: true });
  fs.writeFileSync(path.join(source, "users", "clientes.json"), "clientes e preferencias");
  fs.mkdirSync(destination);
  try {
    const key = crypto.randomBytes(32);
    await createEncryptedArchive(source, output, key);
    const progressUpdates = [];
    await extractEncryptedArchive(output, destination, key, (progress) => progressUpdates.push(progress));
    assert.equal(fs.readFileSync(path.join(destination, "users", "clientes.json"), "utf8"), "clientes e preferencias");
    assert.ok(progressUpdates.length > 0, "a extração deve informar progresso");
    assert.ok(progressUpdates.every((progress) => progress >= 55 && progress <= 87));
    await assert.rejects(extractEncryptedArchive(output, path.join(temp, "wrong-key"), crypto.randomBytes(32)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("arquivo portátil usa senha independente do R2 e recusa senha incorreta", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-portable-backup-test-"));
  const source = path.join(temp, "source");
  const output = path.join(temp, "portable.botbackup");
  const destination = path.join(temp, "restored");
  fs.mkdirSync(path.join(source, "users"), { recursive: true });
  fs.writeFileSync(path.join(source, "users", "clientes.json"), "clientes, histórico e preferências");
  fs.mkdirSync(destination);
  try {
    await createPortableEncryptedArchive(source, output, "senha-portatil-segura-123");
    const encrypted = fs.readFileSync(output);
    assert.equal(encrypted.subarray(0, 8).toString("ascii"), "RMDBK002");
    await extractEncryptedArchive(output, destination, "senha-portatil-segura-123");
    assert.equal(fs.readFileSync(path.join(destination, "users", "clientes.json"), "utf8"), "clientes, histórico e preferências");
    await assert.rejects(extractEncryptedArchive(output, path.join(temp, "wrong-password"), "senha-errada-123"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("recupera dados originais se o processo cair durante a troca", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-restore-recovery-"));
  const rollbackName = ".cloud-restore-rollback-test";
  const stageName = ".cloud-restore-stage-test";
  const rollback = path.join(temp, rollbackName);
  fs.mkdirSync(rollback);
  fs.mkdirSync(path.join(temp, stageName));
  fs.writeFileSync(path.join(rollback, "clientes.json"), "dados anteriores");
  fs.writeFileSync(path.join(temp, "clientes.json"), "dados parciais restaurados");
  fs.writeFileSync(path.join(temp, ".cloud-restore-journal.json"), JSON.stringify({ rollbackName, stageName, phase: "installing" }));
  try {
    recoverInterruptedCloudRestore(temp);
    assert.equal(fs.readFileSync(path.join(temp, "clientes.json"), "utf8"), "dados anteriores");
    assert.equal(fs.existsSync(path.join(temp, ".cloud-restore-journal.json")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("interrupção antes da troca não remove os dados ainda originais", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-restore-before-swap-"));
  const rollbackName = ".cloud-restore-rollback-test";
  const stageName = ".cloud-restore-stage-test";
  fs.mkdirSync(path.join(temp, rollbackName));
  fs.mkdirSync(path.join(temp, stageName));
  fs.writeFileSync(path.join(temp, "clientes.json"), "dados originais intactos");
  fs.writeFileSync(path.join(temp, ".cloud-restore-journal.json"), JSON.stringify({ rollbackName, stageName, phase: "moving" }));
  try {
    recoverInterruptedCloudRestore(temp);
    assert.equal(fs.readFileSync(path.join(temp, "clientes.json"), "utf8"), "dados originais intactos");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
