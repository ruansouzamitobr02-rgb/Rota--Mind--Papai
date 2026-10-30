const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { writeEventStream } = require("../dist/httpEventStream");

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  blocked = true;
  frames = [];
  write(payload) { this.frames.push(payload); return !this.blocked; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("atualização grande espera envio sem derrubar SSE e só guarda o estado mais recente", () => {
  const response = new Response();
  writeEventStream(response, "data: first\n\n");
  assert.equal(response.destroyed, false);
  writeEventStream(response, "data: superseded\n\n");
  writeEventStream(response, "data: latest\n\n");
  writeEventStream(response, ": heartbeat\n\n");
  assert.deepEqual(response.frames, ["data: first\n\n"]);
  response.blocked = false;
  response.emit("drain");
  assert.deepEqual(response.frames, ["data: first\n\n", "data: latest\n\n"]);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.destroyed, false);
});

test("cliente que nunca recebe dados é encerrado sem manter fila ilimitada", async () => {
  const response = new Response();
  writeEventStream(response, "data: blocked\n\n", 15);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(response.destroyed, true);
  assert.equal(response.listenerCount("drain"), 0);
});
