const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), { pathToFileURL } = require("node:url");
const fs = require("node:fs"), os = require("node:os");
const { RouteStore } = require("../dist/bot/routeStore");
const { PreparedSenderKeys } = require("../dist/bot/preparedSenderKeys");
const group = "synthetic-test@g.us";
const pad = bytes => Buffer.concat([Buffer.from(bytes), Buffer.alloc(3, 3)]);
const canonical = message => Buffer.from(JSON.stringify(message));

test("diagnóstico de primeira mensagem e prioridade permanece após reiniciar o histórico", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-relay-history-")), file = path.join(dir, "routes.json");
  const timeline = { eventDetectedAt: new Date().toISOString(), sendStartedAt: new Date().toISOString(), detectionDelayMs: 2, mode: "race", openingSignal: "metadata_check", timeoutUsed: false, retryUsed: false, notAcceptableCount: 0, events: [], coordinationWaitMs: 7, priorityDelayMs: 400, dispatchPriority: { level: 1, delayMs: 400 }, senderKeyPreparedRecipients: 1059, senderKeyCacheHits: 1059, senderKeyCacheMisses: 0, groupEncryptionMs: 2, participantEncryptionMs: 9 };
  Object.assign(timeline, { socketIdleMs: 20, socketProbeFailures: 0, socketRecoveryCount: 1 });
  try {
    const store = new RouteStore(file); store.create({ id: "route", clientEmail: "fixture@test.com", groupJid: group, groupName: "Fixture", mode: "target", messages: ["D-16"], sentMessageIds: ["id"], confirmedCount: 1, totalCount: 1, status: "sent", dispatchTimeline: timeline }); store.flush();
    const restored = new RouteStore(file).all()[0].dispatchTimeline;
    for (const key of ["openingSignal", "coordinationWaitMs", "priorityDelayMs", "senderKeyPreparedRecipients", "senderKeyCacheHits", "senderKeyCacheMisses", "groupEncryptionMs", "participantEncryptionMs"]) assert.equal(restored[key], timeline[key]);
    assert.deepEqual(restored.dispatchPriority, timeline.dispatchPriority);
    for (const key of ["socketIdleMs", "socketProbeFailures", "socketRecoveryCount"]) assert.equal(restored[key], timeline[key]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  let prepared, encryptions = 0, version = "first", hits = 0, misses = 0;
  const repository = {
    jidToSignalProtocolAddress: jid => `address:${jid}`,
    getSenderKeyDistributionMessage: async () => Buffer.from(version),
    encryptMessage: async ({ jid, data }) => {
      const value = ++encryptions;
      prepared?.observeKeyMutation({ session: { [`address:${jid}`]: value } });
      return { type: "pkmsg", ciphertext: Buffer.from(`${value}:${Buffer.from(data).toString("hex")}`) };
    }
  };
  const original = repository.encryptMessage;
  const socket = { signalRepository: repository, authState: { creds: { me: { id: "sender@s.whatsapp.net" } }, keys: { get: async () => ({ [group]: {} }) } },
    createParticipantNodes: async (recipients, message) => Promise.all(recipients.map(jid => repository.encryptMessage({ jid, data: pad(canonical(message)) }))) };
  prepared = new PreparedSenderKeys(socket, { canonical }, hit => { if (hit) hits++; else misses++; });
  const message = () => ({ senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: Buffer.from(version) } });
  return { prepared, socket, original, message, setVersion: value => { version = value; }, stats: () => ({ encryptions, hits, misses }) };
}

test("antecipa somente a distribuição local; primeiro envio usa cifra de uso único sem refazer criptografia", async () => {
  const f = fixture(), jid = "recipient@s.whatsapp.net";
  try {
    assert.equal(await f.prepared.prepare(group, { addressingMode: "pn" }, [jid], () => true), 1);
    assert.equal(f.stats().encryptions, 1);
    assert.equal(f.stats().hits, 0);
    const first = await f.socket.signalRepository.encryptMessage({ jid, data: pad(canonical(f.message())) });
    assert.equal(f.stats().hits, 1); assert.equal(f.stats().encryptions, 1);
    const second = await f.socket.signalRepository.encryptMessage({ jid, data: pad(canonical(f.message())) });
    assert.equal(f.stats().encryptions, 2); assert.notDeepEqual(first.ciphertext, second.ciphertext);
  } finally { f.prepared.dispose(); }
});

test("sessão alterada, chave de grupo diferente e mudança de membros descartam a cifra antecipada", async () => {
  const f = fixture(), jid = "recipient@s.whatsapp.net";
  try {
    await f.prepared.prepare(group, {}, [jid], () => true);
    f.prepared.observeKeyMutation({ session: { [`address:${jid}`]: "new-session" } });
    await f.socket.signalRepository.encryptMessage({ jid, data: pad(canonical(f.message())) });
    assert.equal(f.stats().hits, 0); assert.equal(f.stats().encryptions, 2);
    await f.prepared.prepare(group, {}, [jid], () => true);
    f.setVersion("new-group-key");
    await f.socket.signalRepository.encryptMessage({ jid, data: pad(canonical(f.message())) });
    assert.equal(f.stats().hits, 0);
    f.prepared.invalidate(group); assert.equal(f.prepared.readyCount(group), 0);
  } finally { f.prepared.dispose(); }
});

test("mensagem real, outro destinatário e padding inválido seguem o SDK normal", async () => {
  const f = fixture(), jid = "recipient@s.whatsapp.net";
  try {
    await f.prepared.prepare(group, {}, [jid], () => true);
    await f.socket.signalRepository.encryptMessage({ jid, data: pad(canonical({ conversation: "Cliente D-16" })) });
    await f.socket.signalRepository.encryptMessage({ jid: "different@s.whatsapp.net", data: pad(canonical(f.message())) });
    await f.socket.signalRepository.encryptMessage({ jid, data: Buffer.from([0]) });
    assert.equal(f.stats().hits, 0);
  } finally { f.prepared.dispose(); assert.equal(f.socket.signalRepository.encryptMessage, f.original); }
});

test("cancelamento na abertura para os próximos lotes sem impedir o relay", async () => {
  const f = fixture(); let valid = true;
  const create = f.socket.createParticipantNodes;
  f.socket.createParticipantNodes = async (...args) => { const result = await create(...args); valid = false; return result; };
  try {
    const devices = Array.from({ length: 60 }, (_, i) => `${i}@s.whatsapp.net`);
    const count = await f.prepared.prepare(group, {}, devices, () => valid);
    assert.equal(count, 16); assert.equal(f.stats().encryptions, 16);
  } finally { f.prepared.dispose(); }
});

test("timer não avança novamente as sessões cuja cifra já está pronta", async () => {
  const f = fixture(), jid = "recipient@s.whatsapp.net";
  try {
    await f.prepared.prepare(group, {}, [jid], () => true);
    await f.prepared.prepare(group, {}, [jid], () => true);
    assert.equal(f.stats().encryptions, 1);
  } finally { f.prepared.dispose(); }
});

test("fechamento aguarda o lote em andamento antes de liberar o armazenamento da sessão", async () => {
  const f = fixture(); let release, entered, closed = false;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const create = f.socket.createParticipantNodes;
  f.socket.createParticipantNodes = async (...args) => { entered(); await pending; return create(...args); };
  const preparation = f.prepared.prepare(group, {}, Array.from({ length: 60 }, (_, i) => `${i}@s.whatsapp.net`), () => true);
  await started;
  const closing = f.prepared.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "o armazenamento não pode fechar com trabalho criptográfico pendente");
  assert.equal(f.socket.signalRepository.encryptMessage, f.original);
  release();
  await Promise.all([closing, preparation]);
  assert.equal(closed, true);
  assert.equal(f.stats().encryptions, 16, "o fechamento deve cancelar os próximos lotes");
  assert.equal(f.prepared.readyCount(group), 0);
});

test("aquecimento antecipado preserva a descriptografia Signal real da primeira rota", async t => {
  const baileys = await import("@whiskeysockets/baileys");
  const { makeLibSignalRepository } = await import(pathToFileURL(path.join(path.dirname(require.resolve("@whiskeysockets/baileys")), "Signal", "libsignal.js")).href);
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  let prepared, hits = 0;
  function endpoint(id, observe = false) {
    const values = new Map(), creds = baileys.initAuthCreds(); creds.me = { id };
    const clone = value => JSON.parse(JSON.stringify(value, baileys.BufferJSON.replacer), baileys.BufferJSON.reviver);
    const store = {
      get: async (category, ids) => Object.fromEntries(ids.map(id => [id, values.has(`${category}:${id}`) ? clone(values.get(`${category}:${id}`)) : undefined])),
      set: async data => { for (const [category, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries)) { if (value == null) values.delete(`${category}:${id}`); else values.set(`${category}:${id}`, clone(value)); } if (observe) prepared?.observeKeyMutation(data); }
    };
    const cached = baileys.makeCacheableSignalKeyStore(store, logger);
    const keys = baileys.addTransactionCapability(cached, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
    const auth = { creds, keys }, repo = makeLibSignalRepository(auth, logger);
    t.after(() => repo.close());
    return { auth, repo };
  }
  const alice = endpoint("11111:1@s.whatsapp.net", true), bob = endpoint("22222:1@s.whatsapp.net");
  const preKey = baileys.Curve.generateKeyPair();
  await bob.auth.keys.set({ "pre-key": { "1": preKey } });
  await alice.repo.injectE2ESession({ jid: bob.auth.creds.me.id, session: {
    registrationId: bob.auth.creds.registrationId, identityKey: baileys.generateSignalPubKey(bob.auth.creds.signedIdentityKey.public),
    signedPreKey: { keyId: bob.auth.creds.signedPreKey.keyId, publicKey: baileys.generateSignalPubKey(bob.auth.creds.signedPreKey.keyPair.public), signature: bob.auth.creds.signedPreKey.signature },
    preKey: { keyId: 1, publicKey: baileys.generateSignalPubKey(preKey.public) }
  } });
  const socket = { signalRepository: alice.repo, authState: alice.auth,
    createParticipantNodes: async (recipients, message) => Promise.all(recipients.map(jid => alice.repo.encryptMessage({ jid, data: baileys.encodeWAMessage(message) }))) };
  prepared = new PreparedSenderKeys(socket, { canonical: message => baileys.proto.Message.encode(message).finish() }, hit => { if (hit) hits++; });
  t.after(() => prepared.dispose());
  const recipients = [bob.auth.creds.me.id];
  assert.equal(await prepared.prepare(group, { addressingMode: "pn" }, recipients, () => true), 1);
  assert.equal((await alice.auth.keys.get("sender-key-memory", [group]))[group], undefined, "preparação não pode alegar entrega antes do envio");
  const actual = Buffer.from("Cliente D-16: primeira rota real");
  const encryptedGroup = await alice.repo.encryptGroupMessage({ group, meId: alice.auth.creds.me.id, data: actual });
  const distribution = { senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: encryptedGroup.senderKeyDistributionMessage } };
  const cipher = await alice.repo.encryptMessage({ jid: recipients[0], data: baileys.encodeWAMessage(distribution) });
  assert.equal(hits, 1, "a cifra preparada não foi aproveitada");
  const plain = await bob.repo.decryptMessage({ jid: alice.auth.creds.me.id, type: cipher.type, ciphertext: cipher.ciphertext });
  const decoded = baileys.proto.Message.decode(baileys.unpadRandomMax16(plain));
  await bob.repo.processSenderKeyDistributionMessage({ item: decoded.senderKeyDistributionMessage, authorJid: alice.auth.creds.me.id });
  const decrypted = await bob.repo.decryptGroupMessage({ group, authorJid: alice.auth.creds.me.id, msg: encryptedGroup.ciphertext });
  assert.deepEqual(Buffer.from(decrypted), actual);

  // A restart may discard a prepared frame after its Signal counter committed.
  // The next real frame must remain decryptable with that skipped counter.
  const afterRestart = "restart-test@g.us";
  await prepared.prepare(afterRestart, { addressingMode: "pn" }, recipients, () => true);
  prepared.dispose();
  prepared = new PreparedSenderKeys(socket, { canonical: message => baileys.proto.Message.encode(message).finish() }, hit => { if (hit) hits++; });
  assert.equal(await prepared.prepare(afterRestart, { addressingMode: "pn" }, recipients, () => true), 1);
  const encryptedAfterRestart = await alice.repo.encryptGroupMessage({ group: afterRestart, meId: alice.auth.creds.me.id, data: actual });
  const messageAfterRestart = { senderKeyDistributionMessage: { groupId: afterRestart, axolotlSenderKeyDistributionMessage: encryptedAfterRestart.senderKeyDistributionMessage } };
  const cachedAfterRestart = await alice.repo.encryptMessage({ jid: recipients[0], data: baileys.encodeWAMessage(messageAfterRestart) });
  const decodedAfterRestart = baileys.proto.Message.decode(baileys.unpadRandomMax16(await bob.repo.decryptMessage({ jid: alice.auth.creds.me.id, type: cachedAfterRestart.type, ciphertext: cachedAfterRestart.ciphertext })));
  await bob.repo.processSenderKeyDistributionMessage({ item: decodedAfterRestart.senderKeyDistributionMessage, authorJid: alice.auth.creds.me.id });
  assert.deepEqual(Buffer.from(await bob.repo.decryptGroupMessage({ group: afterRestart, authorJid: alice.auth.creds.me.id, msg: encryptedAfterRestart.ciphertext })), actual);

  // Another normal message changes the session after preparation. The old
  // cached distribution must be discarded and the new one must still decrypt.
  const afterDirect = "changed-session@g.us";
  await prepared.prepare(afterDirect, { addressingMode: "pn" }, recipients, () => true);
  const direct = await alice.repo.encryptMessage({ jid: recipients[0], data: Buffer.from("normal direct message") });
  await bob.repo.decryptMessage({ jid: alice.auth.creds.me.id, type: direct.type, ciphertext: direct.ciphertext });
  const hitsBeforeFallback = hits;
  const third = await alice.repo.encryptGroupMessage({ group: afterDirect, meId: alice.auth.creds.me.id, data: actual });
  const thirdCipher = await alice.repo.encryptMessage({ jid: recipients[0], data: baileys.encodeWAMessage({ senderKeyDistributionMessage: { groupId: afterDirect, axolotlSenderKeyDistributionMessage: third.senderKeyDistributionMessage } }) });
  assert.equal(hits, hitsBeforeFallback, "sessão alterada reaproveitou cifra obsoleta");
  const thirdDecoded = baileys.proto.Message.decode(baileys.unpadRandomMax16(await bob.repo.decryptMessage({ jid: alice.auth.creds.me.id, type: thirdCipher.type, ciphertext: thirdCipher.ciphertext })));
  await bob.repo.processSenderKeyDistributionMessage({ item: thirdDecoded.senderKeyDistributionMessage, authorJid: alice.auth.creds.me.id });
  assert.deepEqual(Buffer.from(await bob.repo.decryptGroupMessage({ group: afterDirect, authorJid: alice.auth.creds.me.id, msg: third.ciphertext })), actual);
});
