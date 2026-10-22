const assert = require("node:assert/strict");
const test = require("node:test");
const { subscribeSnapshots } = require("../dist/desktop/renderer/snapshotSubscription");
const { parseClientSnapshot } = require("../dist/desktop/renderer/clientSnapshot");
const { DEFAULT_CONFIG } = require("../dist/bot/config");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function browserEvents(t) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const document = new EventTarget();
  document.visibilityState = "visible";
  global.document = document;
  global.window = new EventTarget();
  t.after(() => { global.window = previousWindow; global.document = previousDocument; });
  return {
    document,
    window: global.window,
    setVisibility(value) {
      document.visibilityState = value;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  };
}

test("voltar ao app abandona HTTP preso, refaz SSE e ignora resultados da conexão suspensa", async (t) => {
  const browser = browserEvents(t);
  const pending = [];
  const streams = [];
  const received = [];
  const errors = [];
  const stop = subscribeSnapshots({
    intervalMs: 60_000,
    load: (signal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })),
    listen: (receive, fail) => {
      const stream = { receive, fail, closed: false };
      streams.push(stream);
      return () => { stream.closed = true; };
    },
    receive: (snapshot) => received.push(snapshot),
    onError: (error) => errors.push(error)
  });
  t.after(stop);
  assert.equal(pending.length, 1);
  browser.setVisibility("hidden");
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(streams[0].closed, true);
  browser.setVisibility("visible");
  browser.window.dispatchEvent(new Event("focus"));
  browser.window.dispatchEvent(new Event("pageshow"));
  assert.equal(pending.length, 2, "retoma mesmo quando a promessa antiga nunca foi concluída");
  assert.equal(streams.length, 2);
  pending[1].resolve("atual");
  await tick();
  pending[0].resolve("resposta antiga");
  streams[0].receive("evento antigo");
  streams[0].fail();
  await tick();
  assert.deepEqual(received, ["atual"]);
  assert.deepEqual(errors, []);
  streams[1].receive("ao vivo");
  assert.deepEqual(received, ["atual", "ao vivo"]);
  browser.setVisibility("hidden");
  browser.setVisibility("visible");
  assert.equal(pending.length, 3);
  stop();
  assert.equal(pending[2].signal.aborted, true);
  assert.equal(streams[2].closed, true);
  browser.setVisibility("hidden");
  browser.setVisibility("visible");
  assert.equal(pending.length, 3, "cleanup remove os eventos de retomada");
});

test("pageshow do cache e volta da internet renovam a assinatura sem deslogar", async (t) => {
  const browser = browserEvents(t);
  let loads = 0;
  let listeners = 0;
  const stop = subscribeSnapshots({
    intervalMs: 60_000,
    load: async () => ++loads,
    listen: () => { listeners++; return () => {}; },
    receive: () => {}
  });
  t.after(stop);
  await tick();
  browser.window.dispatchEvent(new Event("pagehide"));
  const show = new Event("pageshow");
  show.persisted = true;
  browser.window.dispatchEvent(show);
  await tick();
  assert.equal(loads, 2);
  assert.equal(listeners, 2);
  browser.setVisibility("hidden");
  browser.window.dispatchEvent(new Event("online"));
  assert.equal(loads, 2);
  browser.setVisibility("visible");
  await tick();
  assert.equal(loads, 3);
});

test("snapshot incompleto é recusado antes de substituir a tela válida", () => {
  const valid = { status: "connected", config: { ...DEFAULT_CONFIG }, groups: [], logs: [], readinessChecks: [] };
  assert.equal(parseClientSnapshot(valid), valid);
  for (const value of [null, {}, { ...valid, config: null }, { ...valid, logs: [null] }, { ...valid, config: {} }, { ...valid, ocrRouteSelection: { status: "analyzing" } }]) {
    assert.throws(() => parseClientSnapshot(value), /incompleta/);
  }
});
