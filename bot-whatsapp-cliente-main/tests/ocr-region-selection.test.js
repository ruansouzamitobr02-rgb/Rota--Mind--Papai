const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { selectPreferredNeighborhoodFromOcr, findManualRouteCandidatesFromOcr } = require("../dist/bot/ocrNeighborhoodSelection");
const { ConfigStore } = require("../dist/bot/config");
const { normalizeNeighborhoodPreferences, neighborhoodPreferenceLabel } = require("../dist/desktop/renderer/neighborhoodPreferences");

function line(text, top, left, confidence = 94) {
  let cursor = left;
  const words = text.split(/\s+/).map((text) => {
    const word = { text, top, left: cursor, width: text.length * 9, height: 18, confidence };
    cursor += word.width + 9;
    return word;
  });
  return { text, top, left, width: cursor - left, height: 18, confidence, words };
}

function table(rows, headers = false) {
  const lines = headers ? [line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520), line("CLUSTER", 10, 620), line("BAIRRO", 10, 1050)] : [];
  rows.forEach((row, index) => {
    const y = 60 + index * 40;
    lines.push(line(row.code, y, 20), line("AT20261029BX07R", y, 180), line(String(row.stops || 27), y, 430), line("99", y, 520));
    if (row.region !== undefined) lines.push(line(row.region, y, 620));
    lines.push(line(row.district || "Centro", y, 1050));
  });
  return { text: lines.map((item) => item.text).join("\n"), lines, source: "fixture" };
}

function consensus(rows, headers = false) {
  const first = table(rows, headers);
  return { ...first, variants: [first, structuredClone(first)] };
}

const preference = { cidade: "", bairro: "Centro", regiao: "Campos - Tamandaré" };
const desired = { code: "J-29", stops: 27, region: "Campos - Tamandaré" };
const other = { code: "J-21", stops: 10, region: "Campos - Centro" };

for (const headers of [true, false]) {
  test(`Centro da Tamandaré vence somente na região configurada (${headers ? "com" : "sem"} cabeçalho)`, () => {
    const result = selectPreferredNeighborhoodFromOcr(consensus([other, desired], headers), [preference]);
    assert.equal(result.status, "selected");
    assert.deepEqual(result.selections.map((item) => item.detection.code), ["J-29"]);
    assert.equal(result.detection.regiao, "Campos - Tamandaré");
  });
}

test("Centro de outra região ou sem região legível nunca libera o automático", () => {
  for (const row of [other, { ...desired, region: undefined }, { ...desired, region: "Campos - Tamandaré Norte" }, { ...desired, region: "SJB - Tamandaré" }]) {
    const result = selectPreferredNeighborhoodFromOcr(consensus([row]), [preference]);
    assert.notEqual(result.status, "selected");
    assert.deepEqual(result.selections, []);
  }
});

test("caso relatado confirma Tamandaré e explica bloqueio por 10 paradas e 20 pacotes", () => {
  const source = consensus([{ ...desired, region: "Campos Tamandaré" }, other]);
  const blocked = selectPreferredNeighborhoodFromOcr(source, [preference], 10, 20);
  assert.equal(blocked.status, "unsafe");
  assert.match(blocked.reason, /J-29: Centro \/ Campos Tamandaré confirmados/);
  assert.match(blocked.reason, /27 paradas acima do limite geral de 10/);
  assert.match(blocked.reason, /99 pacotes acima do limite geral de 20/);
  const candidates = findManualRouteCandidatesFromOcr(source);
  assert.equal(candidates.find((candidate) => candidate.code === "J-29").regiao, "Campos Tamandaré");
  const withoutLimits = selectPreferredNeighborhoodFromOcr(source, [preference], 0, 0);
  assert.equal(withoutLimits.status, "selected");
  assert.equal(withoutLimits.detection.code, "J-29");
  assert.ok(withoutLimits.selections.every((item) => item.detection.code !== "J-21"));
});

test("CLUSTER continua sendo isolado quando também existe uma coluna CIDADE", () => {
  const first = table([desired], true);
  first.lines.push(line("CIDADE", 10, 555), line("Campos", 60, 555));
  const result = selectPreferredNeighborhoodFromOcr({ ...first, variants: [first, structuredClone(first)] }, [preference]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.regiao, "Campos - Tamandaré");
});

test("região da linha vizinha não é usada para liberar Centro", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    other, { ...desired, district: "Parque Penha" }
  ]), [preference]);
  assert.notEqual(result.status, "selected");
});

test("duas regiões do mesmo bairro podem ter preferências independentes", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([other, desired]), [
    preference, { bairro: "Centro", regiao: "Campos - Centro" }
  ], 0, 0, "preference");
  assert.deepEqual(result.selections.map((item) => item.detection.code), ["J-29", "J-21"]);
});

test("divergência de região na mesma gaiola bloqueia mesmo com duas leituras concordantes", () => {
  const first = table([desired], true);
  const result = selectPreferredNeighborhoodFromOcr({
    ...first, variants: [first, structuredClone(first), table([{ ...desired, region: "Campos - Centro" }], true)]
  }, [preference]);
  assert.equal(result.status, "unsafe");
  assert.match(result.reason, /região/);
});

test("condição regional exige duas leituras confiáveis da região", () => {
  assert.equal(selectPreferredNeighborhoodFromOcr(table([desired], true), [preference]).status, "unsafe");
  const first = table([desired], true);
  const weak = structuredClone(first);
  weak.lines.find((item) => item.text === desired.region).words.find((word) => word.text === "Tamandaré").confidence = 35;
  assert.equal(selectPreferredNeighborhoodFromOcr({ ...first, variants: [first, weak] }, [preference]).status, "unsafe");
});

test("acento e prefixo completo de Campos são normalizados sem confundir regiões", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([{ ...desired, region: "Campos dos Goytacazes - Tamandare" }]), [preference]);
  assert.equal(result.status, "selected");
});

test("preferência antiga sem região continua aceitando Centro de qualquer região", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([other]), [{ bairro: "Centro" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "J-21");
});

test("outros bairros ignoram restrições regionais antigas e mantêm leitura estrutural única", () => {
  const source = table([{ code: "F-2", stops: 20, region: "Campos - Região diferente", district: "Parque Penha" }], true);
  const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro: "Parque Penha", regiao: "Campos - Outra região" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.evidenceCount, 1);
});

test("configuração e presets preservam região após reiniciar; duplicação considera região", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "region-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  const routes = normalizeNeighborhoodPreferences([preference, { ...preference, regiao: "Campos - Centro" }, { ...preference }]);
  assert.equal(routes.length, 2);
  const store = new ConfigStore(file);
  store.save({ rotasMonitoradasDetalhadas: routes, routePresets: [{ id: "region", name: "Centro certo", routes, createdAt: "2026-10-29", updatedAt: "2026-10-29" }] });
  const reloaded = new ConfigStore(file).load();
  assert.deepEqual(reloaded.rotasMonitoradasDetalhadas, routes);
  assert.deepEqual(reloaded.routePresets[0].routes, routes);
  assert.match(neighborhoodPreferenceLabel(routes[0]), /Centro.*Campos - Tamandaré/);
});
