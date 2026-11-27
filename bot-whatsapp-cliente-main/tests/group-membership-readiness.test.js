const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { BotService } = require("../dist/bot/connection");
const group = "fixture@g.us";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-membership-"));
  const file = name => path.join(dir, `${name}.json`);
  const bot = new BotService({ configPath: file("config"), routeStorePath: file("routes"), dispatchQueuePath: file("queue"), telemetryPath: file("telemetry"), ocrAnalysisHistoryPath: file("ocr"), logStorePath: file("logs") });
  bot.configStore.save({ grupoAlvoJid: group, grupoAlvoNome: "Fixture", nomeEnvio: "Cliente", codigosMensagensAlvo: ["D-16"] });
  bot.status = "connected"; bot.preparedTargetJid = group; bot.emitSnapshot = () => undefined;
  bot.sock = { user: { id: "12345:7@s.whatsapp.net", lid: "90001:7@lid" }, groupMetadata: async () => ({ id: group, announce: true, participants: [{ id: "90001@lid" }] }) };
  t.after(async () => { await bot.logger.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return bot;
}

test("captura inicial confirma participação por LID e atualiza checklist sem enviar mensagens", async t => {
  const bot = fixture(t); let relays = 0;
  bot.prewarmActiveChat = async () => undefined; bot.prewarmGroupCrypto = async () => true;
  bot.sock.relayMessage = async () => { relays++; };
  await bot.captureInitialGroupState();
  assert.equal(bot.getReadinessChecks().find(check => check.id === "participant").ok, true);
  assert.equal(bot.groupState, "closed"); assert.equal(relays, 0);
});

test("metadados frescos removem confirmação quando a própria conta deixa de constar", async t => {
  const bot = fixture(t);
  await bot.refreshGroupMetadata(group); assert.equal(bot.currentUserInTargetGroup, true);
  bot.sock.groupMetadata = async () => ({ id: group, participants: [{ id: "another@lid" }] });
  await bot.refreshGroupMetadata(group); assert.equal(bot.currentUserInTargetGroup, false);
});

test("participação compara PN e LID reais sem equiparar números de domínios diferentes", t => {
  const bot = fixture(t); bot.sock.user = { id: "12345:7@s.whatsapp.net" };
  assert.equal(bot.updateMembershipFromMetadata(group, { id: group, participants: [{ id: "12345@lid" }] }), false);
  assert.equal(bot.updateMembershipFromMetadata(group, { id: group, participants: [{ id: "other@lid", phoneNumber: "12345@s.whatsapp.net" }] }), true);
  assert.equal(bot.updateMembershipFromMetadata(group, { id: group, participants: [{ id: "12345:2@s.whatsapp.net" }] }), true);
});

test("consulta de outro grupo não altera a confirmação do grupo alvo", async t => {
  const bot = fixture(t); await bot.refreshGroupMetadata(group);
  bot.sock.groupMetadata = async jid => ({ id: jid, participants: [] });
  await bot.refreshGroupMetadata("other@g.us"); assert.equal(bot.currentUserInTargetGroup, true);
});

test("resposta de conexão anterior não confirma participação na nova sessão", async t => {
  const bot = fixture(t); let resolve;
  bot.sock.groupMetadata = () => new Promise(done => { resolve = done; });
  const waiting = bot.refreshGroupMetadata(group);
  bot.sock = { user: { id: "new@s.whatsapp.net" } };
  resolve({ id: group, participants: [{ id: "90001@lid" }] });
  assert.equal(await waiting, undefined); assert.equal(bot.currentUserInTargetGroup, false);
});
