const assert = require("node:assert/strict"), path = require("node:path"), { pathToFileURL } = require("node:url"), { performance } = require("node:perf_hooks");
const { PreparedSenderKeys } = require("../dist/bot/preparedSenderKeys");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const baileys = await import("@whiskeysockets/baileys");
  const { makeLibSignalRepository } = await import(pathToFileURL(path.join(path.dirname(require.resolve("@whiskeysockets/baileys")), "Signal", "libsignal.js")).href);
  const count = Math.max(1, Math.min(4096, Number(process.argv[2]) || 1059)), samples = [];
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  for (let iteration = 0; iteration < 3; iteration++) {
    let prepared, hits = 0;
    const values = new Map(), creds = baileys.initAuthCreds();
    creds.me = { id: "11111:1@s.whatsapp.net", lid: "90000001:1@lid" };
    const clone = value => JSON.parse(JSON.stringify(value, baileys.BufferJSON.replacer), baileys.BufferJSON.reviver);
    const store = {
      get: async (category, ids) => Object.fromEntries(ids.map(id => [id, values.has(`${category}:${id}`) ? clone(values.get(`${category}:${id}`)) : undefined])),
      set: async data => { for (const [category, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries)) values.set(`${category}:${id}`, clone(value)); prepared?.observeKeyMutation(data); }
    };
    const auth = { creds, keys: baileys.addTransactionCapability(baileys.makeCacheableSignalKeyStore(store, logger), logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 }) };
    const repository = makeLibSignalRepository(auth, logger);
    const peer = baileys.initAuthCreds(), preKey = baileys.Curve.generateKeyPair();
    const recipients = Array.from({ length: count }, (_, i) => `${7000000000 + i}:1@lid`);
    const session = { registrationId: peer.registrationId, identityKey: baileys.generateSignalPubKey(peer.signedIdentityKey.public), signedPreKey: { keyId: peer.signedPreKey.keyId, publicKey: baileys.generateSignalPubKey(peer.signedPreKey.keyPair.public), signature: peer.signedPreKey.signature }, preKey: { keyId: 1, publicKey: baileys.generateSignalPubKey(preKey.public) } };
    const group = `benchmark-${iteration}@g.us`, text = baileys.encodeWAMessage({ conversation: "Cliente D-16" });
    const socket = { signalRepository: repository, authState: auth, createParticipantNodes: async (jids, message) => Promise.all(jids.map(jid => repository.encryptMessage({ jid, data: baileys.encodeWAMessage(message) }))) };
    try {
      for (const jid of recipients) await repository.injectE2ESession({ jid, session });
      const relayLocally = () => auth.keys.transaction(async () => {
        const result = await repository.encryptGroupMessage({ group, meId: creds.me.lid, data: text });
        return socket.createParticipantNodes(recipients, { senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: result.senderKeyDistributionMessage } });
      }, group);
      const coldStarted = performance.now(); await relayLocally(); const coldMs = performance.now() - coldStarted;
      prepared = new PreparedSenderKeys(socket, { canonical: message => baileys.proto.Message.encode(message).finish() }, hit => { if (hit) hits++; });
      const preparingStarted = performance.now(); assert.equal(await prepared.prepare(group, { addressingMode: "lid" }, recipients, () => true), count); const preparationMs = performance.now() - preparingStarted;
      const readyStarted = performance.now(); await relayLocally(); const readyMs = performance.now() - readyStarted;
      assert.equal(hits, count);
      samples.push({ coldMs, preparationMs, readyMs, hits });
      console.error(`Sample ${iteration + 1}: ${count} recipients; local crypto ${coldMs.toFixed(1)}ms -> ${readyMs.toFixed(1)}ms; preparation ${preparationMs.toFixed(1)}ms before opening.`);
    } finally { prepared?.dispose(); repository.close(); }
  }
  const cold = median(samples.map(item => item.coldMs)), ready = median(samples.map(item => item.readyMs));
  console.log(JSON.stringify({ recipients: count, samples: samples.length, coldMedianMs: +cold.toFixed(1), preparedMedianMs: +ready.toFixed(1), preparationMedianMs: +median(samples.map(item => item.preparationMs)).toFixed(1), localCriticalPathReductionPercent: +((1 - ready / cold) * 100).toFixed(1), cachedRecipientsPerRelay: count, scope: "Real Signal encryption with synthetic local sessions; no WhatsApp connection, no messages sent, excludes network and server acknowledgement." }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
