const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { PanelUserStore } = require("../dist/panelUserStore");
const { hashPassword, verifyPasswordSync } = require("../dist/passwords");
const { createEncryptedArchive, extractEncryptedArchive } = require("../dist/services/cloudBackup");
const email = "client@vault.test", password = "Synthetic-secret-2026!";
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "password-vault-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, "data", "panel_users.json"); return { dir, file, store: new PanelUserStore(file) }; }

test("senhas consultáveis usam cofre autenticado sem texto puro no disco ou alteração do hash de login", t => {
  const { file, store } = setup(t);
  const created = store.upsert({ email, password });
  assert.ok(verifyPasswordSync(password, created.password));
  assert.equal(store.revealPassword(email), password);
  assert.ok(!fs.readFileSync(file, "utf8").includes(password));
  store.recordLogin(email, "127.0.0.1", "fixture"); store.touch(email);
  store.upsert({ email, password: created.password, color: "#aabbcc" });
  assert.equal(new PanelUserStore(file).revealPassword(email), password);
  assert.equal(store.all()[0].sessionVersion, created.sessionVersion);
  const next = store.upsert({ email, password: "Different-fixture!" });
  assert.equal(store.revealPassword(email), "Different-fixture!");
  assert.ok(next.sessionVersion > created.sessionVersion);
  store.rename(email, "renamed@vault.test");
  assert.equal(store.revealPassword("renamed@vault.test"), "Different-fixture!");
  assert.equal(store.revealPassword(email), undefined);
});

test("hash antigo fica indisponível até login correto; senha incorreta e hash alterado não revelam segredo antigo", t => {
  const { store } = setup(t), hash = hashPassword(password);
  store.upsert({ email, password: hash });
  assert.equal(store.revealPassword(email), undefined);
  store.rememberPassword(email, "wrong-fixture");
  assert.equal(store.revealPassword(email), undefined);
  store.rememberPassword(email, password);
  assert.equal(store.revealPassword(email), password);
  assert.equal(store.all()[0].password, hash);
  store.upsert({ email, password: hashPassword("new-hash-fixture") });
  assert.equal(store.revealPassword(email), undefined);
});

test("cifra adulterada ou chave ausente não afetam autenticação e não revelam senha", t => {
  const { store, file } = setup(t); store.upsert({ email, password });
  const users = JSON.parse(fs.readFileSync(file));
  users[0].passwordEncrypted = users[0].passwordEncrypted.replace(/^v1:[^:]+:/, "v1:AAAAAAAAAAAAAAAA:");
  fs.writeFileSync(file, JSON.stringify(users));
  assert.equal(store.revealPassword(email), undefined);
  assert.ok(verifyPasswordSync(password, store.all()[0].password));
  fs.unlinkSync(path.join(path.dirname(file), ".panel-password-key"));
  assert.equal(store.revealPassword(email), undefined);
  assert.ok(verifyPasswordSync(password, store.all()[0].password));
});

test("backup criptografado preserva o cofre e a senha após migração de pasta", async t => {
  const { store, file, dir } = setup(t); store.upsert({ email, password });
  const key = crypto.randomBytes(32), archive = path.join(dir, "snapshot.rmbak"), restored = path.join(dir, "restored");
  await createEncryptedArchive(path.dirname(file), archive, key);
  await extractEncryptedArchive(archive, restored, key);
  assert.equal(new PanelUserStore(path.join(restored, "panel_users.json")).revealPassword(email), password);
});
