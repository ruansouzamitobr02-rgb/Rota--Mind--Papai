const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const sharp = require("sharp");
const { createPreprocessedImages } = require("../dist/bot/ocr");
const { getOcrRuntimeBudget } = require("../dist/services/runtimeCapacity");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-operation-benchmark-"));
  const results = [];
  try {
    for (const dark of [false, true]) {
      const rows = Array.from({ length: 18 }, (_, i) => `<text x="15" y="${90 + i * 35}">M-${i + 1}</text><text x="135" y="${90 + i * 35}">AT20261125000${i}</text><text x="405" y="${90 + i * 35}">27</text><text x="485" y="${90 + i * 35}">99</text><text x="585" y="${90 + i * 35}">Campos - Tamandare</text><text x="900" y="${90 + i * 35}">Centro</text>`).join("");
      const file = path.join(dir, `${dark ? "dark" : "light"}.png`);
      await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="760"><rect width="1080" height="760" fill="${dark ? "#1b2228" : "white"}"/><g font-family="Arial" font-size="20" fill="${dark ? "#edf1f6" : "#171a21"}"><text x="15" y="30">ROTA</text><text x="135" y="30">AT</text><text x="405" y="30">PARADAS</text><text x="585" y="30">CLUSTER</text><text x="900" y="30">BAIRRO</text>${rows}</g></svg>`)).png().toFile(file);
      const samples = { eager: [], lazy: [] }, fileCounts = {};
      for (let sample = 0; sample < 6; sample++) {
        for (const lazy of sample % 2 ? [true, false] : [false, true]) {
          const started = performance.now(), variants = await createPreprocessedImages(file, false, "all", 6, lazy);
          try {
            await Promise.all(variants.slice(0, 2).map(variant => variant.prepare()));
            const mode = lazy ? "lazy" : "eager";
            if (sample > 0) samples[mode].push(performance.now() - started);
            fileCounts[mode] = new Set(variants.filter(variant => variant.generated && fs.existsSync(variant.path)).map(variant => variant.path)).size;
          } finally {
            for (const variant of variants) if (variant.generated) fs.rmSync(variant.path, { force: true });
          }
        }
      }
      const before = median(samples.eager), after = median(samples.lazy);
      results.push({ table: dark ? "dark" : "light", phase: "prepare first two readings out of six possible fallbacks", samples: samples.lazy.length, previousMedianMs: +before.toFixed(1), currentMedianMs: +after.toFixed(1), reductionPercent: +((1 - after / before) * 100).toFixed(1), generatedFilesBefore: fileCounts.eager, generatedFilesAfter: fileCounts.lazy });
    }
    console.log(JSON.stringify({ runtime: getOcrRuntimeBudget(), measurements: results, scope: "Local preprocessing only; excludes OCR recognition, network, WhatsApp acknowledgement and client priority delays." }, null, 2));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
