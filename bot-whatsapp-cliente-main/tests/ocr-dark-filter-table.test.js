const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readRouteImageOcr, shutdownRouteOcrEngine } = require("../dist/bot/ocr");
const { selectPreferredNeighborhoodFromOcr, findManualRouteCandidatesFromOcr } = require("../dist/bot/ocrNeighborhoodSelection");

const cases = [
  ["L-23", "AT20261113COFVV", 54, 77, "Campos - Conselheiro Josino", "Conselheiro Josino"],
  ["N-30", "AT20261113COFPN", 54, 114, "Campos - Cidade Jardim", "Parque Tarcisio Miranda"],
  ["M-24", "AT20261113COFPL", 50, 99, "Campos - Caju", "Parque Caju"],
  ["J-17", "AT20261111CI36N", 51, 86, "Campos - Parque Santa Clara", "Parque Jardim Carioca"],
  ["M-12", "AT20261113COG4Y", 51, 97, "Campos - Travessão", "Travessão"],
  ["M-2", "AT20261113COFZH", 25, 110, "Campos - Tamandaré", "Centro"],
  ["L-26", "AT20261113CONY5", 59, 98, "Campos - Centro", "Centro"],
  ["K-31", "AT20261113CONRQ", 37, 82, "SJB - Centro", "Centro"],
  ["K-29", "AT20261113COFU0", 65, 100, "SJB - Grussaí", "Grussai"],
  ["K-14", "AT20261113CONDZ", 52, 79, "Italva", "São caetano"],
  ["J-5", "AT20261113COO66", 75, 90, "Campos - Codim", "Parque São Silvestre"]
];

function positionedTable(rows, { omitAt = false, omitStops = false } = {}) {
  const lines = [];
  function cell(text, left, top, charWidth = 7.3, height = 15) {
    let cursor = left;
    const words = text.split(" ").map((text) => {
      const word = { text, left: cursor, top, width: text.length * charWidth, height, confidence: 85 };
      cursor += word.width + 4;
      return word;
    });
    lines.push({ text, words, left, top, width: cursor - left, height, confidence: 85 });
  }
  for (const [label, x] of [["ROTA", 6], ["AT", 123], ["PARADAS", 287], ["SPR", 404], ["CLUSTER", 521], ["BAIRRO", 774]]) cell(label, x, 10, 7, 12);
  for (const [index, [code, at, stops, packages, cluster, district]] of rows.entries()) {
    const y = 80 + index * 35;
    cell(code, 8, y);
    if (!omitAt) cell(at, 128, y);
    if (!omitStops) cell(String(stops), 389 - String(stops).length * 8, y);
    cell(String(packages), 505 - String(packages).length * 8, y);
    cell(cluster, 521, y, 8);
    cell(district, 774, y, 8);
  }
  return { text: lines.map((line) => line.text).join("\n"), lines, source: "dark-filter-table" };
}

test("coluna Bairro não incorpora o fim de nomes longos do Cluster", () => {
  for (const row of cases) {
    if (row[5] === "Centro") continue;
    const result = selectPreferredNeighborhoodFromOcr(positionedTable([row]), [{ bairro: row[5] }]);
    assert.equal(result.status, "selected", `${row[0]}: ${JSON.stringify(result)}`);
    assert.equal(result.detection.code, row[0]);
    assert.equal(result.detection.paradas, row[2]);
    assert.equal(result.detection.pacotes, row[3]);
  }
});

test("uma linha com cabeçalho PARADAS/SPR preserva quantidades mesmo com AT ilegível", () => {
  const row = cases[2];
  const result = selectPreferredNeighborhoodFromOcr(positionedTable([row], { omitAt: true }), [{ bairro: row[5] }]);
  assert.equal(result.status, "selected", JSON.stringify(result));
  assert.equal(result.detection.paradas, 50);
  assert.equal(result.detection.pacotes, 99);
});

test("SPR legível não é usado como paradas quando falta a primeira quantidade", () => {
  const row = cases[2];
  const candidates = findManualRouteCandidatesFromOcr(positionedTable([row], { omitAt: true, omitStops: true }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].paradas, undefined);
  assert.equal(candidates[0].pacotes, 99);
});

test("Centro de Tamandaré fica separado de Campos-Centro e SJB-Centro na tabela escura", () => {
  const first = positionedTable(cases.slice(5, 8));
  const result = selectPreferredNeighborhoodFromOcr({ ...first, variants: [first, structuredClone(first)] }, [{ bairro: "Centro", regiao: "Campos - Tamandaré" }]);
  assert.equal(result.status, "selected", JSON.stringify(result));
  assert.equal(result.detection.code, "M-2");
  assert.equal(result.detection.paradas, 25);
  assert.equal(result.detection.pacotes, 110);
});

test("rotas do mesmo bairro continuam ordenadas por paradas e respeitam os limites", () => {
  const rows = [
    ["M-9", "AT20261113COOGE", 61, 95, "Campos - Travessão", "Travessão"],
    ["M-10", "AT20261113COOGF", 50, 96, "Campos - Travessão", "Travessão"]
  ];
  const ocr = positionedTable(rows);
  const result = selectPreferredNeighborhoodFromOcr(ocr, [{ bairro: "Travessão" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "M-10");
  assert.equal(selectPreferredNeighborhoodFromOcr(ocr, [{ bairro: "Travessão" }], 10).status, "unsafe");
  assert.equal(selectPreferredNeighborhoodFromOcr(ocr, [{ bairro: "Travessão" }], 0, 20).status, "unsafe");
});

function renderTable(rows, headers = true) {
  const headerHeight = headers ? 68 : 0;
  const height = headerHeight + rows.length * 35;
  const columns = [0, 114, 278, 395, 512, 766, 1040];
  const labels = ["ROTA", "AT", "PARADAS", "SPR", "CLUSTER", "BAIRRO"];
  const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const header = headers ? `<rect width="1040" height="68" fill="#20272d"/>` + labels.map((label, i) =>
    `<text x="${columns[i] + 7}" y="21" font-size="13" font-weight="bold" fill="#a6b5c3">${label}</text>` +
    `<rect x="${columns[i] + 7}" y="32" width="${columns[i + 1] - columns[i] - 16}" height="28" rx="5" fill="#171c21" stroke="#363d46"/>` +
    `<text x="${columns[i] + 13}" y="51" font-size="15" fill="${i === 4 ? "#e1e7eb" : "#777"}">${i === 4 ? "— todos — ▾" : "filtrar..."}</text>`).join("") : "";
  const body = rows.map(([code, at, stops, packages, cluster, district], i) => {
    const top = headerHeight + i * 35;
    const y = top + 24;
    return `<rect y="${top}" width="1040" height="35" fill="${i % 2 ? "#171c21" : "#1c2126"}"/>` +
      `<path d="M0 ${top} H1040" stroke="#30363d"/>` +
      `<g font-family="Consolas, monospace" font-size="16"><text x="8" y="${y}" fill="#ecf1f5" font-weight="bold">${code}</text><text x="128" y="${y}" fill="#a9bccb">${at}</text></g>` +
      `<g font-size="16" fill="#e7edf3"><text x="389" y="${y}" text-anchor="end" font-weight="bold">${stops}</text><text x="505" y="${y}" text-anchor="end" font-weight="bold">${packages}</text><text x="521" y="${y}" fill="#a7bac9">${escape(cluster)}</text><text x="774" y="${y}">${escape(district)}</text></g>`;
  }).join("");
  return Buffer.from(`<svg width="1040" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="1040" height="${height}" fill="#171c21"/><g font-family="Arial">${header}${body}</g>${columns.map(x => `<path d="M${x} 0 V${height}" stroke="#2a3037"/>`).join("")}</svg>`);
}

test("OCR real lê tabelas escuras com filtros, linha única e recorte sem cabeçalho", { skip: process.env.RUN_REAL_OCR_TESTS !== "1", timeout: 180000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-dark-filter-"));
  const sharp = require("sharp");
  try {
    for (const [name, rows, headers] of [["single", [cases[2]], true], ["compressed-jpeg", [cases[2]], true], ["long-cluster", [cases[1]], true], ["multiple", cases, true], ["cropped", cases.slice(8), false]]) {
      const image = path.join(directory, `${name}.${name === "compressed-jpeg" ? "jpg" : "png"}`);
      const input = sharp(renderTable(rows, headers));
      await (name === "compressed-jpeg" ? input.resize({ width: 940 }).jpeg({ quality: 68 }) : input.png()).toFile(image);
      const started = Date.now();
      const ocr = await readRouteImageOcr(image, { maxReadings: 1, fastFirst: true, preferCageCrop: false });
      t.diagnostic(`${name}: ${Date.now() - started}ms`);
      const result = selectPreferredNeighborhoodFromOcr(ocr, rows.filter(row => row[5] !== "Centro").map(row => ({ bairro: row[5] })), 0, 0, "preference");
      assert.equal(result.status, "selected", JSON.stringify({ result, text: ocr.text }));
      for (const row of rows.filter(row => row[5] !== "Centro")) {
        const selected = result.selections.find(item => item.detection.code === row[0]);
        assert.ok(selected, `${name}: ${row[0]} ausente: ${JSON.stringify(result)}`);
        assert.equal(selected.detection.paradas, row[2]);
        assert.equal(selected.detection.pacotes, row[3]);
      }
    }
    const regionalImage = path.join(directory, "centro-regioes.png");
    await sharp(renderTable(cases.slice(5, 8))).png().toFile(regionalImage);
    const regionalOcr = await readRouteImageOcr(regionalImage, { maxReadings: 2, fastFirst: true, preferCageCrop: false });
    const region = selectPreferredNeighborhoodFromOcr(regionalOcr, [{ bairro: "Centro", regiao: "Campos - Tamandaré" }]);
    assert.equal(region.status, "selected", JSON.stringify({ region, variants: regionalOcr.variants.map(item => item.text) }));
    assert.equal(region.detection.code, "M-2");
    assert.equal(region.detection.paradas, 25);
    assert.equal(region.detection.pacotes, 110);
  } finally { await shutdownRouteOcrEngine(); fs.rmSync(directory, { recursive: true, force: true }); }
});
