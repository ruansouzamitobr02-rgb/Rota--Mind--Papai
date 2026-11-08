const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { selectPreferredNeighborhoodFromOcr } = require("../dist/bot/ocrNeighborhoodSelection.js");
const { combineRouteImageBatch, readRouteImageOcr, shutdownRouteOcrEngine } = require("../dist/bot/ocr.js");

const preferred = [
  { cidade: "Campos dos Goytacazes", bairro: "Parque Rodoviário" },
  { cidade: "Campos dos Goytacazes", bairro: "Centro" }
];

function line(text, top = 30, left = 20, confidence = 94) {
  let cursor = left;
  const words = text.split(/\s+/).map((word) => {
    const result = { text: word, left: cursor, top, width: word.length * 10, height: 20, confidence };
    cursor += result.width + 12;
    return result;
  });
  return { text, top, left, width: cursor - left, height: 20, confidence, words };
}

function reading(rows, source = "contrast") {
  const lines = rows.map((row, index) => typeof row === "string" ? line(row, 30 + index * 40) : row);
  return { text: lines.map((item) => item.text).join("\n"), lines, source };
}

function consensus(rows) {
  const variants = [reading(rows, "contrast"), reading(rows, "binary")];
  return { ...variants[0], variants };
}

test("ordena bairros confirmados pela menor quantidade de paradas", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "B-12 AT2026092600001 45 109 Campos dos Goytacazes Centro",
    "F-14 AT2026092600002 77 Campos dos Goytacazes Parque Rodoviário"
  ]), preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.preferenceIndex, 1);
  assert.equal(result.detection.code, "B-12");
  assert.equal(result.detection.evidenceCount, 2);
  assert.deepEqual(result.selections.map((item) => item.detection.code), ["B-12", "F-14"]);
});

test("cerebro por preferencia respeita o ranking mesmo com mais paradas", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "F-14 AT2026101100001 59 118 Campos Parque Rodoviário",
    "B-12 AT2026101100002 15 119 Campos Centro"
  ]), preferred, 0, 0, "preference", "stops");
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-14");
  assert.deepEqual(result.selections.map((item) => item.detection.code), ["F-14", "B-12"]);
});

test("cerebro por quantidade permite escolher menos pacotes", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "F-14 AT2026101100001 15 119 Campos Parque Rodoviário",
    "B-12 AT2026101100002 59 90 Campos Centro"
  ]), preferred, 0, 0, "quantity", "packages");
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "B-12");
  assert.equal(result.detection.pacotes, 90);
});

test("passa à próxima preferência apenas quando a anterior está ausente", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus(["B-12 Campos dos Goytacazes Centro"]), preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.preferenceIndex, 1);
});

test("lê a primeira quantidade após o AT como paradas sem aplicar limites", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "I-19 AT20261006APWGR 42 93 Campos Parque João Maria",
    "G-17 AT20261006APHFA 18 92 Campos Goytacazes"
  ]), [
    { cidade: "Campos", bairro: "Parque João Maria" },
    { cidade: "Campos", bairro: "Goytacazes" }
  ]);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "G-17");
  assert.equal(selected.detection.paradas, 18);
  assert.deepEqual(selected.selections.map((item) => item.detection.paradas), [18, 42]);
});

test("uma unica quantidade depois do AT e pacotes, nao paradas", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "D-5 AT20261008ASZGE 109 SJB Grussai",
    "F-32 AT20261008ASZKV 132 Campos Parque Caju"
  ]), [
    { bairro: "Grussai" },
    { bairro: "Parque Caju" }
  ], 50);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "D-5");
  assert.deepEqual(selected.selections.map((item) => item.detection.paradas), [undefined, undefined]);
  assert.deepEqual(selected.selections.map((item) => item.detection.pacotes), [109, 132]);
  assert.doesNotMatch(selected.reason, /acima do limite/);
});

test("limite de pacotes descarta a rota e usa a proxima preferencia elegivel", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "J-13 AT20261007ARASB 44 98 Campos Caju Parque Leopoldina",
    "J-12 AT20261007ARPLK 58 82 Campos Caju Parque Caju"
  ]), [
    { bairro: "Parque Leopoldina" },
    { bairro: "Parque Caju" }
  ], 0, 90);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "J-12");
  assert.equal(selected.detection.pacotes, 82);
  assert.match(selected.reason, /próxima preferência elegível/);
});

test("sem paradas legiveis respeita o ranking e ainda aplica limite de pacotes", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "D-5 AT20261008ASZGE 109 SJB Grussai",
    "F-32 AT20261008ASZKV 88 Campos Parque Caju"
  ]), [
    { bairro: "Grussai" },
    { bairro: "Parque Caju" }
  ], 0, 100);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "F-32");
});

test("limite geral descarta somente rotas acima do máximo", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "I-19 AT20261006APWGR 42 93 Campos Parque João Maria",
    "G-17 AT20261006APHFA 18 92 Campos Goytacazes"
  ]), [
    { cidade: "Campos", bairro: "Parque João Maria" },
    { cidade: "Campos", bairro: "Goytacazes" }
  ], 30);
  assert.equal(selected.status, "selected");
  assert.deepEqual(selected.selections.map((item) => item.detection.code), ["G-17"]);
  assert.match(selected.reason, /1 rota\(s\) acima do limite/);
});

test("condicao de paradas descarta somente o bairro configurado", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "J-13 AT20261007ARASB 58 98 Campos Parque Leopoldina",
    "J-12 AT20261007ARPLK 70 98 Campos Parque Caju"
  ]), [
    { bairro: "Parque Leopoldina", conditionMetric: "stops", conditionMax: 50 },
    { bairro: "Parque Caju" }
  ]);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "J-12");
  assert.deepEqual(selected.selections.map((item) => item.detection.code), ["J-12"]);
});

test("condicao individual de pacotes nao afeta os demais bairros", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "I-21 AT20261006APWGS 23 92 Campos Parque Rosario",
    "G-29 AT20261006APWEW 31 77 Campos Parque Caju"
  ]), [
    { bairro: "Parque Rosario", conditionMetric: "packages", conditionMax: 90 },
    { bairro: "Parque Caju" }
  ]);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "G-29");
});

test("quantidade ilegivel nao bloqueia uma condicao individual", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "I-21 AT20261006APWGS Campos Parque Rosario"
  ]), [{ bairro: "Parque Rosario", conditionMetric: "stops", conditionMax: 20 }]);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "I-21");
});

test("sem leitura de paradas mantém a ordem de preferência e não bloqueia", () => {
  const selected = selectPreferredNeighborhoodFromOcr(consensus([
    "G-17 Campos Goytacazes",
    "I-19 Campos Parque João Maria"
  ]), [
    { cidade: "Campos", bairro: "Parque João Maria" },
    { cidade: "Campos", bairro: "Goytacazes" }
  ], 30);
  assert.equal(selected.status, "selected");
  assert.deepEqual(selected.selections.map((item) => item.detection.code), ["I-19", "G-17"]);
});

test("não troca bairros parecidos, prefixos, palavras parciais ou cidades", () => {
  for (const text of [
    "F-14 Campos dos Goytacazes Parque Rosário",
    "F-14 Campos dos Goytacazes Parque Rodoviário Novo",
    "F-14 Campos dos Goytacazes Novo Parque Rodoviário",
    "F-14 Campos dos Goytacazes Parque Rodoviarlo",
    "F-14 São João da Barra Parque Rodoviário",
    "F-14 Campos dos Goytacazes Novo Centro"
  ]) assert.equal(selectPreferredNeighborhoodFromOcr(consensus([text]), preferred).status, "no-match", text);
});

test("normaliza somente acentuação, caixa e separadores explícitos", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "F-14 | CAMPOS DOS GOYTACAZES | PARQUE RODOVIARIO / Pelinca"
  ]), preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-14");
});

test("bairro repetido escolhe a primeira ocorrencia visual confirmada", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "F-14 Campos dos Goytacazes Parque Rodoviário",
    "H-20 Campos dos Goytacazes Parque Rodoviário",
    "B-12 Campos dos Goytacazes Centro"
  ]), preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.preferenceIndex, 0);
  assert.equal(result.detection.code, "F-14");
});

test("conflito entre tratamentos bloqueia mesmo contra duas leituras concordantes", () => {
  const variants = [
    reading(["F-14 Campos dos Goytacazes Parque Rodoviário"], "a"),
    reading(["F-14 Campos dos Goytacazes Parque Rodoviário"], "b"),
    reading(["F-1 Campos dos Goytacazes Parque Rodoviário"], "c")
  ];
  assert.equal(selectPreferredNeighborhoodFromOcr({ ...variants[0], variants }, preferred).status, "unsafe");
});

test("leitura fraca de uma ocorrencia posterior nao veta o primeiro bairro confirmado", () => {
  const weak = reading(["H-20 Campos dos Goytacazes Parque Rodoviário"], "weak");
  weak.lines[0].confidence = 59;
  weak.lines[0].words.forEach((word) => { word.confidence = 59; });
  const variants = [
    reading(["F-14 Campos dos Goytacazes Parque Rodoviário"], "a"),
    reading(["F-14 Campos dos Goytacazes Parque Rodoviário"], "b"),
    weak
  ];
  const result = selectPreferredNeighborhoodFromOcr({ ...variants[0], variants }, preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-14");
});

test("duas leituras iguais superam uma leitura sem letra da gaiola", () => {
  const variant = (code, source) => reading([
    line("ROTA", 10, 20), line("CIDADE", 10, 500), line("BAIRRO", 10, 1000),
    line(code, 60, 20), line("Sao Francisco de Itabapoana", 60, 500), line("Floresta", 60, 1000)
  ], source);
  const variants = [variant("G-2", "a"), variant("G-2", "b"), variant("6-2", "c")];
  const result = selectPreferredNeighborhoodFromOcr({ ...variants[0], variants }, [{ cidade: "", bairro: "Floresta" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "G-2");
  assert.equal(result.detection.evidenceCount, 2);

  const insufficient = [variant("G-2", "a"), variant("6-2", "b")];
  assert.equal(selectPreferredNeighborhoodFromOcr(
    { ...insufficient[0], variants: insufficient }, [{ cidade: "", bairro: "Floresta" }]
  ).status, "unsafe");
});

test("não inventa I a partir de 1, l, barra ou letra duplicada", () => {
  for (const code of ["1-24", "l-24", "|-24", "II-24"]) {
    const result = selectPreferredNeighborhoodFromOcr(consensus([`${code} Campos dos Goytacazes Parque Rodoviário`]), preferred);
    assert.equal(result.status, "unsafe", code);
  }
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus(["I-24 Campos dos Goytacazes Parque Rodoviário"]), preferred).status, "selected");
});

test("recupera I-24 pela gaiola ambigua quando a mesma linha possui AT completo", () => {
  for (const code of ["1-24", "l-24", "|-24"]) {
    const result = selectPreferredNeighborhoodFromOcr(consensus([
      `${code} AT20260926ABWU3 100 Campos dos Goytacazes Parque Presidente Vargas`
    ]), [{ cidade: "Campos dos Goytacazes", bairro: "Parque Presidente Vargas" }]);
    assert.equal(result.status, "selected", code);
    assert.equal(result.detection.code, "I-24", code);
  }
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus([
    "1-24 100 Campos dos Goytacazes Parque Presidente Vargas"
  ]), [{ cidade: "Campos dos Goytacazes", bairro: "Parque Presidente Vargas" }]).status, "unsafe");
});

test("AT completo impede a baixa confianca do caractere I de vetar I-24", () => {
  const row = line("I-24 AT20260926ABWU3 100 Campos dos Goytacazes Parque Presidente Vargas");
  row.words[0].confidence = 18;
  const variants = [reading([structuredClone(row)], "a"), reading([structuredClone(row)], "b")];
  const result = selectPreferredNeighborhoodFromOcr({ ...variants[0], variants }, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Presidente Vargas" }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "I-24");
  assert.ok(result.detection.confidence >= 65);
});

test("recupera I-6 lido como dois hifens somente com tres evidencias e AT", () => {
  const text = "--6 | AT20260926ABV48 | 88 Campos dos Goytacazes | Parque Leopoldina";
  const variants = [reading([text], "a"), reading([text], "b"), reading([text], "c")];
  const preference = [{ cidade: "Campos dos Goytacazes", bairro: "Parque Leopoldina" }];
  const result = selectPreferredNeighborhoodFromOcr({ ...variants[0], variants }, preference);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "I-6");

  const onlyTwo = variants.slice(0, 2);
  assert.equal(selectPreferredNeighborhoodFromOcr({ ...onlyTwo[0], variants: onlyTwo }, preference).status, "unsafe");
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus([
    "--6 | 88 Campos dos Goytacazes | Parque Leopoldina"
  ]), preference).status, "unsafe");
});

test("não usa gaiola da linha vizinha e reúne fragmentos da mesma linha visual", () => {
  const unsafe = consensus([
    line("F-14", 30, 20),
    line("Campos dos Goytacazes Parque Rodoviário", 55, 200)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(unsafe, preferred).status, "unsafe");
  const safe = consensus([
    line("F-14", 30, 20),
    line("Campos dos Goytacazes Parque Rodoviário", 34, 200)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(safe, preferred).status, "selected");
});

test("reconstrói linhas quando o OCR agrupa toda uma coluna em um bloco", () => {
  const code = line("F-14", 30, 20);
  const nextCode = line("B-12", 70, 20);
  const grouped = { ...code, text: "F-14 B-12", height: 60, words: [...code.words, ...nextCode.words] };
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    grouped,
    line("Campos dos Goytacazes Parque Rodoviário", 30, 200),
    line("Campos dos Goytacazes Centro", 70, 200)
  ]), preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-14");
});

test("palavra com confiança baixa não veta duas leituras concordantes do bairro", () => {
  const row = line("F-14 Campos dos Goytacazes Parque Rodoviário");
  row.words.at(-1).confidence = 20;
  const selected = selectPreferredNeighborhoodFromOcr(consensus([row]), preferred);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.confidence, 20);
  assert.equal(selectPreferredNeighborhoodFromOcr(reading([row]), preferred).status, "unsafe");
});

function lowConfidenceTable(confidence, code = "F-14", stops = 27, at = "AT2026110700001") {
  return reading([
    line("ROTA", 10, 20, confidence), line("AT", 10, 180, confidence),
    line("PARADAS", 10, 430, confidence), line("PACOTES", 10, 520, confidence),
    line("CLUSTER", 10, 620, confidence), line("BAIRRO", 10, 1050, confidence),
    line(code, 60, 20, confidence), line(at, 60, 180, confidence),
    line(String(stops), 60, 430, confidence), line("99", 60, 520, confidence),
    line("Campos - Parque Rodoviário", 60, 620, confidence), line("Parque Rodoviário", 60, 1050, confidence)
  ]);
}

test("linha completa da tabela libera com uma leitura mesmo abaixo de 65 por cento", () => {
  for (const confidence of [64, 35, 20, 0]) {
    const result = selectPreferredNeighborhoodFromOcr(lowConfidenceTable(confidence), preferred);
    assert.equal(result.status, "selected", String(confidence));
    assert.equal(result.detection.code, "F-14");
    assert.equal(result.detection.evidenceCount, 1);
    assert.equal(result.detection.confidence, confidence);
    assert.equal(result.detection.paradas, 27);
    assert.equal(result.detection.pacotes, 99);
  }
});

test("sem cabeçalho, linha completa com confiança baixa continua automática", () => {
  const source = lowConfidenceTable(20);
  source.lines = source.lines.filter((item) => item.top > 10);
  source.text = source.lines.map((item) => item.text).join("\n");
  const result = selectPreferredNeighborhoodFromOcr(source, preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-14");
});

test("gaiola com menos paradas não perde para outra só por ter confiança menor", () => {
  const source = lowConfidenceTable(94, "F-5", 59, "AT2026110700001");
  const low = lowConfidenceTable(10, "F-9", 15, "AT2026110700002");
  for (const item of low.lines.filter((row) => row.top > 10)) {
    item.top += 40;
    for (const word of item.words) word.top += 40;
    source.lines.push(item);
  }
  source.text = source.lines.map((item) => item.text).join("\n");
  const result = selectPreferredNeighborhoodFromOcr(source, preferred);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-9");
  assert.equal(result.detection.paradas, 15);
  assert.equal(result.detection.confidence, 10);
});

test("reajuste de confiança preserva limites gerais, individuais e preferências pausadas", () => {
  const source = lowConfidenceTable(15);
  assert.equal(selectPreferredNeighborhoodFromOcr(source, preferred, 10).status, "unsafe");
  assert.equal(selectPreferredNeighborhoodFromOcr(source, preferred, 0, 20).status, "unsafe");
  assert.equal(selectPreferredNeighborhoodFromOcr(source, [{ ...preferred[0], conditionMetric: "stops", conditionMax: 10 }]).status, "unsafe");
  assert.equal(selectPreferredNeighborhoodFromOcr(source, [{ ...preferred[0], enabled: false }]).status, "unconfigured");
});

test("confiança baixa não mistura gaiola de outra linha nem bairros parecidos", () => {
  const source = lowConfidenceTable(10);
  for (const item of source.lines) if (item.text === "F-14") {
    item.top += 40;
    for (const word of item.words) word.top += 40;
  }
  assert.notEqual(selectPreferredNeighborhoodFromOcr(source, preferred).status, "selected");
  assert.equal(selectPreferredNeighborhoodFromOcr(lowConfidenceTable(10), [{ bairro: "Rodoviário" }]).status, "no-match");
});

test("duas leituras de baixa confiança que discordam sobre a gaiola do mesmo AT não disparam", () => {
  const first = lowConfidenceTable(20, "F-14");
  const second = lowConfidenceTable(15, "F-1");
  const result = selectPreferredNeighborhoodFromOcr({ ...first, variants: [first, second] }, preferred);
  assert.equal(result.status, "unsafe");
  assert.match(result.reason, /mesmo AT.*gaiolas diferentes/);
});

test("texto sem geometria/confiança nunca é evidência para envio automático", () => {
  const source = { text: "F-14 Campos dos Goytacazes Parque Rodoviário", lines: [], source: "sem-tsv" };
  assert.equal(selectPreferredNeighborhoodFromOcr({ ...source, variants: [source, source] }, preferred).status, "unsafe");
});

test("nenhuma preferência jamais vira seleção automática de todas as gaiolas", () => {
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus(["F-14 Cidade Centro"]), []).status, "unconfigured");
});

test("preferência pausada permanece salva mas é ignorada pela análise", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "F-14 Campos dos Goytacazes Centro",
    "H-20 Campos dos Goytacazes Parque Rodoviário"
  ]), [
    { cidade: "Campos dos Goytacazes", bairro: "Centro", enabled: false },
    { cidade: "Campos dos Goytacazes", bairro: "Parque Rodoviário", enabled: true }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "H-20");
  assert.equal(result.preferenceIndex, 1);
});

test("cidade opcional usa a coluna BAIRRO, sem confundir sufixo de bairro maior", () => {
  const headers = [line("GAIOLA", 10, 20), line("CIDADE", 10, 250), line("BAIRRO", 10, 700)];
  const source = consensus([
    ...headers,
    line("F-14", 60, 20), line("Cidade", 60, 250), line("Centro", 60, 700)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(source, [{ cidade: "", bairro: "Centro" }]).status, "selected");
  const longer = consensus([
    ...headers,
    line("F-14", 60, 20), line("Cidade", 60, 250), line("Novo Centro", 60, 700)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(longer, [{ cidade: "", bairro: "Centro" }]).status, "no-match");
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus(["F-14 Cidade Centro"]), [{ cidade: "", bairro: "Centro" }]).status, "selected");
});

test("layout novo usa somente BAIRRO mesmo quando CLUSTER pertence a outra cidade", () => {
  const headers = [line("ROTA", 10, 20), line("AT", 10, 220), line("CLUSTER", 10, 520), line("BAIRRO", 10, 850)];
  const campos = consensus([
    ...headers,
    line("H-31", 60, 20), line("AT2026092600001", 60, 220), line("Campos - Centro", 60, 520), line("Centro", 60, 850)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(campos, preferred).status, "selected");

  const outraCidade = consensus([
    ...headers,
    line("G-32", 60, 20), line("AT2026092600002", 60, 220), line("Italva", 60, 520), line("Centro", 60, 850)
  ]);
  assert.equal(selectPreferredNeighborhoodFromOcr(outraCidade, preferred).status, "selected");

  assert.equal(selectPreferredNeighborhoodFromOcr(consensus([
    "J-21 AT2026092600003 78 Parque Rodoviário"
  ]), preferred).status, "selected");
});

test("captura clara sem cabecalho encontra o bloco cidade-bairro sem misturar a outra localidade", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "PM J-6 AT202609059D9VB 106 Parque Presidente Vargas Campos - Parque Santa Clara",
    "PM G-32 AT202609059DITO 89 Centro Italva"
  ]), [{ cidade: "Campos dos Goytacazes", bairro: "Parque Santa Clara" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "J-6");

  const wrongCity = selectPreferredNeighborhoodFromOcr(consensus([
    "PM G-32 AT202609059DITO 89 Centro Italva"
  ]), [{ cidade: "Campos dos Goytacazes", bairro: "Centro" }]);
  assert.equal(wrongCity.status, "no-match");

  const withoutHyphen = selectPreferredNeighborhoodFromOcr(consensus([
    "PM H-31 AT202609059D9V8 85 Centro Campos Centro",
    "PM G-32 AT202609059DITO 89 Centro Italva"
  ]), [{ cidade: "Campos dos Goytacazes", bairro: "Centro" }]);
  assert.equal(withoutHyphen.status, "selected");
  assert.equal(withoutHyphen.detection.code, "H-31");
});

test("aceita sublinhado, espaco ou ausencia de separador na gaiola sublinhada", () => {
  for (const code of ["H_31", "H 31", "H31"]) {
    const result = selectPreferredNeighborhoodFromOcr(consensus([
      `PM ${code} AT202609059D9V8 85 Centro Campos Centro`
    ]), [{ cidade: "Campos dos Goytacazes", bairro: "Centro" }]);
    assert.equal(result.status, "selected", code);
    assert.equal(result.detection.code, "H-31", code);
  }
});

test("layout sem cabecalho aceita Campos abreviado na configuracao e cidade completa na imagem", () => {
  const result = selectPreferredNeighborhoodFromOcr(consensus([
    "H-17 AT20260926ABVRN 106 Campos dos Goytacazes Centro",
    "G-2 AT20260926ABWLR 79 Sao Francisco de Itabapoana Floresta"
  ]), [
    { cidade: "Campos", bairro: "Floresta" },
    { cidade: "Campos", bairro: "Centro" }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.preferenceIndex, 1);
  assert.equal(result.detection.code, "H-17");
});

test("layout sem cabecalho usa a ultima coluna quando a cidade nao foi configurada", () => {
  const visualRow = (code, at, quantity, city, district, top) => [
    line(code, top, 20), line(at, top, 150), line(String(quantity), top, 410),
    line(city, top, 540), line(district, top, 1050)
  ];
  const rows = [
    ...visualRow("H-17", "AT20260926ABVRN", 106, "Campos dos Goytacazes", "Centro", 30),
    ...visualRow("G-2", "AT20260926ABWLR", 79, "Sao Francisco de Itabapoana", "Floresta", 70)
  ];
  const result = selectPreferredNeighborhoodFromOcr(consensus(rows), [
    { cidade: "", bairro: "Floresta" },
    { cidade: "", bairro: "Centro" }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.preferenceIndex, 0);
  assert.equal(result.detection.code, "G-2");

  const longer = consensus(visualRow("H-17", "AT20260926ABVRN", 106, "Campos dos Goytacazes", "Novo Centro", 30));
  assert.equal(selectPreferredNeighborhoodFromOcr(longer, [{ cidade: "", bairro: "Centro" }]).status, "no-match");
});

test("adapta os novos layouts claros por estrutura sem depender de recorte fixo", () => {
  const cases = [
    {
      text: "B-16 AT20261002AJHLT 89 SFI - ST/Gargaú",
      preference: { cidade: "São Francisco de Itabapoana", bairro: "ST/Gargaú" },
      code: "B-16"
    },
    {
      text: "F-30 AT20261002AJJT4 35 Campos - Farol; Campos - Mussurepe; Campos - Novo Jockey; Campos - Penha; Campos - Santo Amaro de Campos",
      preference: { cidade: "Campos dos Goytacazes", bairro: "Mussurepe" },
      code: "F-30"
    },
    {
      text: "D-28 AT20261002AJJZV 121 Campos - Ururaí",
      preference: { cidade: "Campos dos Goytacazes", bairro: "Ururaí" },
      code: "D-28"
    }
  ];

  for (const item of cases) {
    const result = selectPreferredNeighborhoodFromOcr(consensus([item.text]), [item.preference]);
    assert.equal(result.status, "selected", item.text);
    assert.equal(result.detection.code, item.code, item.text);
  }
});

test("cabecalhos variaveis isolam CLUSTER e BAIRRO automaticamente", () => {
  const withDistrict = consensus([
    line("ROTA", 10, 20), line("AT", 10, 180), line("SPR", 10, 430),
    line("CLUSTER", 10, 620), line("BAIRRO", 10, 1050),
    line("F-24", 60, 20), line("AT20261002AJK75", 60, 180), line("116", 60, 430),
    line("Campos - Parque Aurora", 60, 620), line("Parque Aurora", 60, 1050)
  ]);
  const selected = selectPreferredNeighborhoodFromOcr(withDistrict, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Aurora" }
  ]);
  assert.equal(selected.status, "selected");
  assert.equal(selected.detection.code, "F-24");

  const wrongDistrict = selectPreferredNeighborhoodFromOcr(withDistrict, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Rosário" }
  ]);
  assert.equal(wrongDistrict.status, "no-match");

  const headerlessWithExtraNumber = consensus([
    line("J-31", 60, 20), line("AT20261002AKD40", 60, 180), line("46", 60, 430), line("83", 60, 520),
    line("Campos - Parque João Maria", 60, 620), line("Parque Rosário", 60, 1120)
  ]);
  const inferredLastColumn = selectPreferredNeighborhoodFromOcr(headerlessWithExtraNumber, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Rosário" }
  ]);
  assert.equal(inferredLastColumn.status, "selected");
  assert.equal(inferredLastColumn.detection.code, "J-31");
  assert.equal(inferredLastColumn.detection.paradas, 46);
  assert.equal(inferredLastColumn.detection.pacotes, 83);
});

test("recupera paradas pela geometria das colunas na linha J-13", () => {
  const source = consensus([
    line("J-13", 60, 20), line("AT20261007ARASB", 60, 180),
    line("44", 60, 430), line("98", 60, 520),
    line("Campos - Caju", 60, 620), line("Parque Leopoldina", 60, 1050)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro: "Parque Leopoldina" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "J-13");
  assert.equal(result.detection.paradas, 44);
});

test("aceita preferencia Flamboyant com ou sem prefixo de cidade", () => {
  const source = reading([
    line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520),
    line("CLUSTER", 10, 620), line("BAIRRO", 10, 1050),
    line("F-5", 60, 20), line("AT20261011BILVK", 60, 180), line("59", 60, 430), line("118", 60, 520),
    line("Campos - Flamboyant", 60, 620), line("Flamboyant", 60, 1050)
  ]);

  for (const bairro of ["Campos - Flamboyant", "Flamboyant"]) {
    const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro }]);
    assert.equal(result.status, "selected", bairro);
    assert.equal(result.detection.code, "F-5", bairro);
    assert.equal(result.detection.bairro, "Flamboyant", bairro);
    assert.equal(result.detection.paradas, 59, bairro);
    assert.equal(result.detection.pacotes, 118, bairro);
  }
});

test("mesmo bairro com varias gaiolas escolhe a de menor numero de paradas", () => {
  const source = reading([
    line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520), line("CLUSTER", 10, 620),
    line("F-5", 60, 20), line("AT20261011BILVK", 60, 180), line("59", 60, 430), line("118", 60, 520), line("Campos - Flamboyant", 60, 620),
    line("F-9", 100, 20), line("AT20261011BILVL", 100, 180), line("15", 100, 430), line("119", 100, 520), line("Campos - Flamboyant", 100, 620)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro: "Campos - Flamboyant" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-9");
  assert.equal(result.detection.paradas, 15);
  assert.ok(result.detections.some((detection) => detection.code === "F-5" && detection.paradas === 59));
});

test("entre gaiolas do mesmo bairro escolhe a menor que respeita a condicao", () => {
  const source = reading([
    line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520), line("CLUSTER", 10, 620),
    line("F-5", 60, 20), line("AT20261011BILVK", 60, 180), line("59", 60, 430), line("118", 60, 520), line("Campos - Flamboyant", 60, 620),
    line("F-9", 100, 20), line("AT20261011BILVL", 100, 180), line("15", 100, 430), line("119", 100, 520), line("Campos - Flamboyant", 100, 620)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [{
    bairro: "Flamboyant", conditionMetric: "packages", conditionMax: 118
  }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-5");
  assert.equal(result.detection.pacotes, 118);
});

test("nao remove Campos quando faz parte do nome real do bairro", () => {
  const source = reading([
    line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520), line("BAIRRO", 10, 1050),
    line("H-19", 60, 20), line("AT20261011BILVX", 60, 180), line("34", 60, 430), line("103", 60, 520), line("Jardins de Campos", 60, 1050)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro: "Jardins de Campos" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.bairro, "Jardins de Campos");
});

test("uma leitura estrutural completa libera J-13 sem esperar tratamentos extras", () => {
  const source = reading([
    line("J-13", 60, 20), line("AT20261007ARASB", 60, 180),
    line("44", 60, 430), line("98", 60, 520),
    line("Campos - Caju", 60, 620), line("Parque Leopoldina", 60, 1050)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [{ bairro: "Parque Leopoldina" }]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "J-13");
  assert.equal(result.detection.paradas, 44);
  assert.equal(result.detection.pacotes, 98);
  assert.equal(result.detection.evidenceCount, 1);
});

test("usa as colunas da tabela quando o AT da J-13 fica ilegivel", () => {
  const source = consensus([
    line("ROTA", 10, 20), line("AT", 10, 180), line("PARADAS", 10, 430), line("PACOTES", 10, 520),
    line("CLUSTER", 10, 620), line("BAIRRO", 10, 1050),
    line("J-17", 60, 20), line("AT20261007ARQ30", 60, 180), line("56", 60, 430), line("90", 60, 520), line("Campos Aeroporto", 60, 620), line("Parque Aeroporto", 60, 1050),
    line("J-13", 100, 20), line("AT20261007ARA?B", 100, 180), line("uu", 100, 430), line("98", 100, 520), line("Campos Caju", 100, 620), line("Parque Leopoldina", 100, 1050),
    line("J-12", 140, 20), line("AT20261007ARPLK", 140, 180), line("58", 140, 430), line("98", 140, 520), line("Campos Caju", 140, 620), line("Parque Caju", 140, 1050),
    line("J-10", 180, 20), line("AT20261007ARPLJ", 180, 180), line("50", 180, 430), line("85", 180, 520), line("Campos Santa Cruz", 180, 620), line("Parque Corrientes", 180, 1050)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [
    { bairro: "Parque Leopoldina" },
    { bairro: "Parque Caju" }
  ]);
  assert.equal(result.status, "selected");
  const byCode = new Map(result.selections.map((item) => [item.detection.code, item.detection]));
  assert.equal(byCode.get("J-13").paradas, 44);
  assert.equal(byCode.get("J-13").pacotes, 98);
  assert.equal(byCode.get("J-12").paradas, 58);
  assert.equal(byCode.get("J-12").pacotes, 98);
});

test("F-24 lido como F-2u continua automatico com AT e Parque Aurora exatos", () => {
  const source = consensus([
    line("ROTA", 10, 20), line("AT", 10, 180), line("SPR", 10, 430),
    line("CLUSTER", 10, 620), line("BAIRRO", 10, 1050),
    line("F-2u", 60, 20), line("AT20261002AJK75", 60, 180), line("116", 60, 430),
    line("Campos - Parque Aurora", 60, 620), line("Parque Aurora", 60, 1050)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Aurora" }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-24");
  assert.equal(result.detection.evidenceCount, 2);

  const withoutAt = consensus(["F-2u 116 Campos - Parque Aurora Parque Aurora"]);
  assert.notEqual(selectPreferredNeighborhoodFromOcr(withoutAt, [
    { cidade: "Campos dos Goytacazes", bairro: "Parque Aurora" }
  ]).status, "selected");
});

test("cluster e bairro fundidos como Parque Aurora duplicado continuam automaticos", () => {
  const source = consensus([
    line("ROTA", 10, 20), line("AT", 10, 140), line("SPR", 10, 300),
    line("CLUSTER", 10, 410), line("BAIRRO", 10, 600),
    line("F-2u", 60, 20), line("AT20261002AJK75", 60, 140), line("116", 60, 300),
    line("(Campos", 60, 410), line("Parque", 60, 490), line("Aurora", 60, 560),
    line("Parque", 60, 630), line("Aurora", 60, 700)
  ]);
  const result = selectPreferredNeighborhoodFromOcr(source, [
    { cidade: "Campos", bairro: "Parque Aurora" }
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.detection.code, "F-24");

  const differentLastCell = consensus([
    "F-2u AT20261002AJK75 116 Campos Parque Aurora Parque Rosario"
  ]);
  assert.notEqual(selectPreferredNeighborhoodFromOcr(differentLastCell, [
    { cidade: "Campos", bairro: "Parque Aurora" }
  ]).status, "selected");
});

test("linha com um código válido e outro ilegível continua ambígua", () => {
  assert.equal(selectPreferredNeighborhoodFromOcr(consensus([
    "1-24 F-14 Campos dos Goytacazes Parque Rodoviário"
  ]), preferred).status, "unsafe");
});

test("lote mantém coordenadas de fotos separadas e não empresta gaiola entre fotos", () => {
  const photoA = consensus(["F-14 Campos dos Goytacazes Centro"]);
  const photoB = consensus(["H-20 Campos dos Goytacazes Parque Rodoviário"]);
  const combined = combineRouteImageBatch([photoA, photoB]);
  assert.equal(selectPreferredNeighborhoodFromOcr(combined, preferred).detection.code, "H-20");
  const noCode = consensus(["Campos dos Goytacazes Parque Rodoviário"]);
  const partial = selectPreferredNeighborhoodFromOcr(combineRouteImageBatch([photoA, noCode]), preferred);
  assert.equal(partial.status, "selected");
  assert.deepEqual(partial.selections.map((item) => item.detection.code), ["F-14"]);
});

test("OCR real mantém cidade e bairro à direita da imagem completa", {
  skip: process.env.RUN_REAL_OCR_TESTS !== "1", timeout: 180000
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-neighborhood-ocr-"));
  try {
    const sharp = require("sharp");
    const image = path.join(temp, "table.png");
    const svg = `<svg width="1400" height="310" xmlns="http://www.w3.org/2000/svg"><rect width="1400" height="310" fill="white"/>
      <g font-family="Arial" font-size="28" fill="black">
      <text x="25" y="55">GAIOLA</text><text x="380" y="55">CIDADE</text><text x="1010" y="55">BAIRRO</text>
      <text x="25" y="130">F-14</text><text x="380" y="130">Campos dos Goytacazes</text><text x="1010" y="130">Parque Rodoviario</text>
      <text x="25" y="220">B-12</text><text x="380" y="220">Campos dos Goytacazes</text><text x="1010" y="220">Centro</text>
      </g></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(image);
    const ocr = await readRouteImageOcr(image, { preferCageCrop: false, fastFirst: false, maxReadings: 5 });
    const result = selectPreferredNeighborhoodFromOcr(ocr, preferred);
    assert.equal(result.status, "selected", JSON.stringify({ result, text: ocr.variants?.map((item) => item.text) }));
    assert.equal(result.detection.code, "F-14");
    assert.ok(result.detection.evidenceCount >= 2);
  } finally {
    await shutdownRouteOcrEngine();
    assert.ok(path.resolve(temp).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
