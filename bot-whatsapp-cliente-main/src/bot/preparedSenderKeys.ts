import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";

type Cipher = { type: string; ciphertext: Uint8Array };
type Prepared = { group: string; epoch: number; dependencies: Array<[string, number]>; cipher: Cipher };
type Preparation = { group: string; hash: string; epoch: number; valid: () => boolean };
type Codec = { canonical: (message: unknown) => Uint8Array };
const MAX_RECIPIENTS = 4096;
const CHUNK_SIZE = 16;

/**
 * Prepare ONLY sender-key distribution ciphers locally. No socket relay, key
 * distribution or sender-key-memory acknowledgement happens during preparation.
 * The regular SDK relay still builds/sends the first real group message.
 */
export class PreparedSenderKeys {
  private readonly entries = new Map<string, Prepared>();
  private readonly sessionVersions = new Map<string, number>();
  private readonly context = new AsyncLocalStorage<Preparation>();
  private readonly writes = new AsyncLocalStorage<Map<string, number>>();
  private epoch = 0;
  private disposed = false;
  private preparing?: Promise<number>;
  private readonly repository: any;
  private readonly originalEncrypt: any;
  private readonly wrappedEncrypt: any;

  constructor(private readonly socket: any, private readonly codec: Codec, private readonly record: (hit: boolean, startedAt: number, finishedAt: number) => void = () => undefined) {
    this.repository = socket.signalRepository;
    this.originalEncrypt = this.repository.encryptMessage;
    this.wrappedEncrypt = async (input: { jid: string; data: Uint8Array }) => {
      const preparation = this.context.getStore();
      if (preparation) {
        if (!preparation.valid() || preparation.epoch !== this.epoch) throw new Error("Preparação local interrompida.");
        // Called through the SDK's createParticipantNodes, so its per-recipient
        // mutex and the repository's normal transaction/commit remain intact.
        const dependencies = new Map<string, number>();
        const cipher = await this.writes.run(dependencies, () => this.originalEncrypt.call(this.repository, input));
        if (dependencies.size && preparation.valid() && preparation.epoch === this.epoch && !this.disposed
          && [...dependencies].every(([id, version]) => this.sessionVersions.get(id) === version)) {
          if (this.entries.size >= MAX_RECIPIENTS) this.entries.delete(this.entries.keys().next().value!);
          this.entries.set(this.key(input.jid, preparation.hash), {
            group: preparation.group, epoch: this.epoch,
            dependencies: [...dependencies],
            cipher: { type: cipher.type, ciphertext: Buffer.from(cipher.ciphertext) }
          });
        }
        return cipher;
      }

      const startedAt = Date.now();
      const hash = this.unpaddedHash(input.data);
      const key = hash ? this.key(input.jid, hash) : "";
      const cached = key ? this.entries.get(key) : undefined;
      if (cached) {
        // One-use ciphers: retries never replay a consumed cryptographic frame.
        this.entries.delete(key);
        if (this.isValid(cached)) {
          this.record(true, startedAt, Date.now());
          return { type: cached.cipher.type, ciphertext: Buffer.from(cached.cipher.ciphertext) };
        }
      }
      try { return await this.originalEncrypt.call(this.repository, input); }
      finally { this.record(false, startedAt, Date.now()); }
    };
    this.repository.encryptMessage = this.wrappedEncrypt;
  }

  static supported(socket: any) {
    return typeof socket?.signalRepository?.encryptMessage === "function"
      && typeof socket.signalRepository.getSenderKeyDistributionMessage === "function"
      && typeof socket.signalRepository.jidToSignalProtocolAddress === "function"
      && typeof socket.createParticipantNodes === "function";
  }

  observeKeyMutation(data: Record<string, Record<string, unknown>>) {
    if (this.disposed) return;
    for (const id of Object.keys(data.session || {})) {
      const version = (this.sessionVersions.get(id) || 0) + 1;
      this.sessionVersions.set(id, version);
      this.writes.getStore()?.set(id, version);
    }
    // Address/identity changes require a new cipher, even if the visible JID
    // stayed unchanged. Sender-key iterations are checked by payload hash.
    if (Object.keys(data["lid-mapping"] || {}).length || Object.keys(data["identity-key"] || {}).length || this.sessionVersions.size > 20_000) {
      this.epoch++; this.entries.clear(); this.sessionVersions.clear();
    }
  }

  async prepare(group: string, metadata: any, devices: string[], valid: () => boolean): Promise<number> {
    if (this.disposed || !valid()) return this.readyCount(group);
    if (this.preparing) return this.preparing;
    const task = this.prepareNow(group, metadata, devices, valid);
    this.preparing = task;
    try { return await task; }
    finally { if (this.preparing === task) this.preparing = undefined; }
  }

  private async prepareNow(group: string, metadata: any, devices: string[], valid: () => boolean) {
    const keys = this.socket.authState?.keys, me = this.socket.authState?.creds?.me || this.socket.user;
    const meId = (metadata?.addressingMode || "lid") === "lid" && me?.lid ? me.lid : me?.id;
    if (!meId || typeof keys?.get !== "function" || !valid()) return this.readyCount(group);
    const memory = await keys.get("sender-key-memory", [group]);
    if (this.disposed || !valid()) return this.readyCount(group);
    const senderKey = await this.repository.getSenderKeyDistributionMessage({ group, meId });
    if (this.disposed || !valid()) return this.readyCount(group);
    const message = { senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: senderKey } };
    const hash = this.hash(this.codec.canonical(message));
    // Remove obsolete group payloads without ever claiming that a recipient
    // received a distribution message which has not actually been sent.
    for (const [key, item] of this.entries) if (item.group === group && !key.endsWith(`\0${hash}`)) this.entries.delete(key);
    const targets = [...new Set(devices)].filter(jid => !memory?.[group]?.[jid] && !/:(?:99)@/.test(jid) && !/@hosted(?:\.lid)?$/.test(jid)).slice(0, MAX_RECIPIENTS);
    const preparation: Preparation = { group, hash, epoch: this.epoch, valid };

    for (let start = 0; start < targets.length && valid() && !this.disposed && preparation.epoch === this.epoch; start += CHUNK_SIZE) {
      const chunk: string[] = [];
      for (const jid of targets.slice(start, start + CHUNK_SIZE)) {
        const entry = this.entries.get(this.key(jid, hash));
        if (entry && this.isValid(entry)) continue;
        chunk.push(jid);
      }
      if (!valid() || preparation.epoch !== this.epoch) break;
      if (chunk.length) {
        await this.context.run(preparation, () => this.socket.createParticipantNodes(chunk, message, {}));
      }
      // Let an opening/cancellation event interrupt the remaining work. No
      // large transaction is held across chunks or across participant locks.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return this.readyCount(group);
  }

  readyCount(group: string) {
    let count = 0;
    for (const item of this.entries.values()) if (item.group === group && this.isValid(item)) count++;
    return count;
  }

  invalidate(group?: string) {
    // Also invalidates an in-flight preparation before it can republish.
    this.epoch++; this.entries.clear();
  }

  dispose() {
    this.disposed = true; this.invalidate(); this.sessionVersions.clear();
    if (this.repository.encryptMessage === this.wrappedEncrypt) this.repository.encryptMessage = this.originalEncrypt;
  }

  async close() {
    this.dispose();
    // The current SDK chunk may still be committing ratchet state. Drain it
    // before its auth store is flushed/closed, including on reconnect/restore.
    await this.preparing?.catch(() => undefined);
  }

  private isValid(item: Prepared) {
    return !this.disposed && item.epoch === this.epoch && item.dependencies.every(([id, version]) => (this.sessionVersions.get(id) || 0) === version);
  }
  private key(jid: string, hash: string) { return `${jid}\0${hash}`; }
  private hash(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
  private unpaddedHash(input: Uint8Array) {
    if (!input.length) return undefined;
    const padding = input[input.length - 1];
    if (padding < 1 || padding > 16 || padding > input.length) return undefined;
    for (let index = input.length - padding; index < input.length; index++) if (input[index] !== padding) return undefined;
    return this.hash(input.subarray(0, input.length - padding));
  }
}
