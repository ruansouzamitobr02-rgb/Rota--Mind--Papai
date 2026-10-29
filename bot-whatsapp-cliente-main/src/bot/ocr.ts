import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createWorker } from "tesseract.js";
import { MonitoredRoute, RomaneioRouteSummary } from "../shared/types";

type OcrWord = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
};

export type OcrLine = {
  text: string;
  words: OcrWord[];
  top: number;
  left: number;
  width: number;
  height: number;
  confidence: number;
};

export type RouteOcrResult = {
  text: string;
  lines: OcrLine[];
  source: string;
  variants?: RouteOcrResult[];
};

export type RouteImageLayoutPreset = "dark-modern" | "light-orange" | "light-left";

export type DetectedRouteCode = {
  route: string;
  cidade?: string;
  bairro?: string;
  regiao?: string;
  paradas?: number;
  pacotes?: number;
  code: string;
  plannedAt?: string;
  line: string;
  confidence: number;
  evidenceCount: number;
  variantCount: number;
  safeForAutomatic: boolean;
};

let tesseractJsWorkerPromise: ReturnType<typeof createWorker> | undefined;
let tesseractJsRecognitionQueue: Promise<void> = Promise.resolve();
let nativeTesseractAvailable: boolean | undefined;
const OCR_TURBO_MODE = process.env.OCR_TURBO_MODE === "true";
const OCR_VARIANT_CONCURRENCY = Math.max(1, Math.min(5,
  Number.parseInt(process.env.OCR_VARIANT_CONCURRENCY || (OCR_TURBO_MODE ? "4" : "3"), 10) || 3
));
const OCR_FALLBACK_BATCH_SIZE = OCR_TURBO_MODE ? 2 : 1;

export function normalizeOcrText(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[|()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function readImageText(imagePath: string) {
  return readRouteImageOcr(imagePath).then((result) => result.text);
}

export async function readRouteImageOcr(imagePath: string, options: { maxReadings?: number; fastFirst?: boolean; preferCageCrop?: boolean } = {}) {
  const variants: Awaited<ReturnType<typeof createPreprocessedImages>> = [];

  try {
    if (options.fastFirst && options.preferCageCrop) {
      const cageVariants = await createPreprocessedImages(imagePath, true, "cage");
      variants.push(...cageVariants);
      const maxReadings = Math.max(1, options.maxReadings || 6);
      const firstVariants = cageVariants.slice(0, Math.min(2, maxReadings));
      const firstAttempts = await runOcrVariants(firstVariants);
      const firstReadings = firstAttempts.flatMap((attempt) => attempt.reading ? [attempt.reading] : []);
      const firstErrors = firstAttempts.flatMap((attempt) => attempt.error ? [attempt.error] : []);

      if (canUseFastOcrResult(firstReadings)) return combineOcrReadings(firstReadings);

      const remainingLimit = Math.max(0, maxReadings - firstVariants.length);
      if (!remainingLimit) {
        if (!firstReadings.length) throw new Error(firstErrors[0] || "Nenhuma versão da imagem pôde ser analisada.");
        return combineOcrReadings(firstReadings);
      }

      const extraCageVariants = cageVariants.slice(firstVariants.length, firstVariants.length + remainingLimit);
      const extraCageAttempts = await runOcrVariants(extraCageVariants);
      let readings = [...firstReadings, ...extraCageAttempts.flatMap((attempt) => attempt.reading ? [attempt.reading] : [])];
      let errors = [...firstErrors, ...extraCageAttempts.flatMap((attempt) => attempt.error ? [attempt.error] : [])];
      const fullReadingLimit = remainingLimit - extraCageVariants.length;
      if (fullReadingLimit > 0) {
        const fullVariants = await createPreprocessedImages(imagePath, false, "full", fullReadingLimit);
        variants.push(...fullVariants);
        const fullAttempts = await runOcrVariants(fullVariants.slice(0, fullReadingLimit));
        readings = [...readings, ...fullAttempts.flatMap((attempt) => attempt.reading ? [attempt.reading] : [])];
        errors = [...errors, ...fullAttempts.flatMap((attempt) => attempt.error ? [attempt.error] : [])];
      }
      if (!readings.length) throw new Error(errors[0] || "Nenhuma versão da imagem pôde ser analisada.");
      return combineOcrReadings(readings);
    }

    variants.push(...await createPreprocessedImages(imagePath, options.preferCageCrop, "all", options.maxReadings));
    const maxReadings = Math.max(1, Math.min(variants.length, options.maxReadings || variants.length));
    const selectedVariants = variants.slice(0, maxReadings);
    const fastReadingCount = options.fastFirst ? Math.min(2, selectedVariants.length) : selectedVariants.length;
    const attempts = await runOcrVariants(selectedVariants.slice(0, fastReadingCount));
    let readings = attempts.flatMap((attempt) => attempt.reading ? [attempt.reading] : []);
    let errors = attempts.flatMap((attempt) => attempt.error ? [attempt.error] : []);

    if (options.fastFirst && fastReadingCount < selectedVariants.length && canUseFastOcrResult(readings)) {
      return combineOcrReadings(readings);
    }

    if (fastReadingCount < selectedVariants.length) {
      // Os tratamentos de fallback são progressivos. Assim que uma leitura
      // adicional fecha o consenso, evitamos gastar CPU nas demais imagens.
      const remainingVariants = selectedVariants.slice(fastReadingCount);
      for (let index = 0; index < remainingVariants.length; index += OCR_FALLBACK_BATCH_SIZE) {
        const fallbackAttempts = await runOcrVariants(remainingVariants.slice(index, index + OCR_FALLBACK_BATCH_SIZE));
        readings = [...readings, ...fallbackAttempts.flatMap((attempt) => attempt.reading ? [attempt.reading] : [])];
        errors = [...errors, ...fallbackAttempts.flatMap((attempt) => attempt.error ? [attempt.error] : [])];
        if (options.fastFirst && canUseFastOcrResult(readings)) break;
      }
    }

    if (!readings.length) {
      throw new Error(errors[0] || "Nenhuma versão da imagem pôde ser analisada.");
    }
    return combineOcrReadings(readings);
  } finally {
    for (const variant of variants) {
      if (!variant.generated) continue;
      try {
        fs.rmSync(variant.path, { force: true });
      } catch {
        // Arquivo temporário já pode ter sido removido.
      }
    }
  }
}

function runOcrVariants(items: Awaited<ReturnType<typeof createPreprocessedImages>>) {
  return mapWithConcurrency(items, OCR_VARIANT_CONCURRENCY, async (variant) => {
    try {
      return { reading: await readSingleRouteImageOcr(variant.path, variant.label, variant.psm) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function combineOcrReadings(readings: RouteOcrResult[]): RouteOcrResult {
  const primary = readings[0];
  return {
    ...primary,
    source: readings.map((reading) => reading.source).join(" + "),
    variants: readings
  };
}

export function canUseFastOcrResult(readings: RouteOcrResult[]) {
  if (readings.length < 2) return false;
  const detected = findAllGaiolaCodesFromOcr(combineOcrReadings(readings));
  const safe = detected.filter(isSafeAutomaticGaiolaDetection);
  const strongestReadingCount = Math.max(...readings.map((reading) => findAllGaiolaCodesFromOcr(reading).length));
  const isolated = detected.filter((route) => !isSafeAutomaticGaiolaDetection(route) && route.confidence >= 45);
  const minimumCoverage = Math.max(1, Math.ceil(strongestReadingCount * 0.85));
  const minimumConsensusShare = Math.max(1, Math.ceil(detected.length * 0.85));
  const toleratedIsolatedNoise = Math.max(1, Math.floor(strongestReadingCount * 0.1));
  const broadTableConsensus = readings.length === 2 && safe.length >= 3 &&
    safe.length >= Math.ceil(strongestReadingCount * 0.5);
  return broadTableConsensus || strongestReadingCount > 0 &&
    safe.length >= minimumCoverage &&
    safe.length >= minimumConsensusShare &&
    isolated.length <= toleratedIsolatedNoise;
}

export function isSafeAutomaticGaiolaDetection(detection: DetectedRouteCode) {
  // Duas leituras independentes já formam consenso. Exigir metade dos seis
  // tratamentos fazia o automático rejeitar códigos que o modo por escolha
  // exibia corretamente em duas versões da mesma imagem.
  const requiredEvidence = 2;
  return detection.safeForAutomatic && detection.confidence >= 45 && detection.evidenceCount >= requiredEvidence;
}

export function calculateCageColumnCrop(imageWidth: number, imageHeight: number, resizedWidth: number, resizedHeight: number) {
  void imageWidth;
  void imageHeight;
  // O layout novo usa DATA/TURNO/ROTA e fundo escuro. A coluna procurada fica
  // entre 8% e 42% da imagem; a faixa também continua cobrindo a antiga GAIOLA.
  // Não tentamos mais encontrar "blocos escuros", pois no tema novo toda a
  // tabela é escura e esse heurístico cortava justamente a coluna ROTA.
  const left = Math.max(0, Math.floor(resizedWidth * 0.08));
  return {
    left,
    top: 0,
    width: Math.max(1, Math.min(resizedWidth - left, Math.floor(resizedWidth * 0.34))),
    height: resizedHeight
  };
}

export function calculateDarkRouteColumnCrop(imageWidth: number, imageHeight: number) {
  return {
    left: Math.max(0, Math.floor(imageWidth * 0.16)),
    top: 0,
    width: Math.max(1, Math.min(imageWidth, Math.floor(imageWidth * 0.23))),
    height: imageHeight
  };
}

export function calculateDarkRouteAtColumnCrop(imageWidth: number, imageHeight: number) {
  return {
    left: Math.max(0, Math.floor(imageWidth * 0.16)),
    top: 0,
    width: Math.max(1, Math.min(imageWidth, Math.floor(imageWidth * 0.42))),
    height: imageHeight
  };
}

export function isDarkRouteImage(meanLuminance: number) {
  return Number.isFinite(meanLuminance) && meanLuminance < 128;
}

export function classifyRouteImageLayout(meanLuminance: number, orangeRatio = 0): RouteImageLayoutPreset {
  if (isDarkRouteImage(meanLuminance)) return "dark-modern";
  if (Number.isFinite(orangeRatio) && orangeRatio >= 0.04) return "light-orange";
  return "light-left";
}

export function calculatePresetRouteCrop(preset: RouteImageLayoutPreset, imageWidth: number, imageHeight: number) {
  if (preset === "dark-modern") return calculateDarkRouteColumnCrop(imageWidth, imageHeight);
  const widthRatio = preset === "light-orange" ? 0.18 : 0.35;
  return { left: 0, top: 0, width: Math.max(1, Math.floor(imageWidth * widthRatio)), height: imageHeight };
}

export function calculatePresetRouteAtCrop(preset: RouteImageLayoutPreset, imageWidth: number, imageHeight: number) {
  if (preset === "dark-modern") return calculateDarkRouteAtColumnCrop(imageWidth, imageHeight);
  const widthRatio = preset === "light-orange" ? 0.34 : 0.48;
  return { left: 0, top: 0, width: Math.max(1, Math.floor(imageWidth * widthRatio)), height: imageHeight };
}

export function calculateFocusedOcrWidth(cropWidth: number) {
  return Math.max(620, Math.min(1000, Math.round(cropWidth * 1.65)));
}

export function combineRouteImageBatch(readings: RouteOcrResult[]): RouteOcrResult {
  if (!readings.length) return { text: "", lines: [], source: "lote-vazio", variants: [] };
  const readingVariants = readings.map((reading) => reading.variants?.length ? reading.variants : [reading]);
  const variantCount = Math.max(...readingVariants.map((items) => items.length));
  const variants = Array.from({ length: variantCount }, (_, variantIndex) => {
    const parts = readingVariants.flatMap((items) => items[variantIndex] ? [items[variantIndex]] : []);
    return {
      text: parts.map((part) => part.text).join("\n"),
      lines: combineImageLines(parts),
      source: parts.map((part) => part.source).join(" + lote + ")
    };
  });
  return {
    text: readings.map((reading) => reading.text).join("\n"),
    lines: combineImageLines(readings),
    source: readings.map((reading) => reading.source).join(" + lote + "),
    variants
  };
}

function combineImageLines(readings: RouteOcrResult[]) {
  let nextTop = 0;
  return readings.flatMap((reading) => {
    if (!reading.lines.length) return [];
    const firstTop = Math.min(...reading.lines.map((line) => line.top));
    const offset = nextTop - firstTop;
    const lines = reading.lines.map((line) => ({
      ...line,
      top: line.top + offset,
      words: line.words.map((word) => ({ ...word, top: word.top + offset }))
    }));
    nextTop = Math.max(...lines.map((line) => line.top + line.height)) + 100;
    return lines;
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readSingleRouteImageOcr(imagePath: string, label: string, psm = 6) {
  if (label.startsWith("coluna-gaiola")) {
    return readCageOcrWithFallback(
      () => readRouteImageOcrWithTesseractJs(imagePath, label, psm),
      () => readRouteImageOcrWithBinary(imagePath, label, psm),
      nativeTesseractAvailable === false
    );
  }
  return readRouteImageOcrWithBinary(imagePath, label, psm)
    .catch(() => readRouteImageOcrWithTesseractJs(imagePath, label, psm));
}

export async function readCageOcrWithFallback(
  readJs: () => Promise<RouteOcrResult>,
  readBinary: () => Promise<RouteOcrResult>,
  binaryUnavailable = false
) {
  let jsError: unknown;
  try {
    const reading = await readJs();
    if (findAllGaiolaCodesFromOcr(reading).length || binaryUnavailable) return reading;
    try {
      return await readBinary();
    } catch {
      // A leitura JS concluída continua válida mesmo quando o binário opcional
      // não existe ou rejeita esta variante.
      return reading;
    }
  } catch (error) {
    jsError = error;
  }
  try {
    return await readBinary();
  } catch (binaryError) {
    throw jsError || binaryError;
  }
}

function readRouteImageOcrWithBinary(imagePath: string, label: string, psm: number) {
  return new Promise<RouteOcrResult>((resolve, reject) => {
    if (nativeTesseractAvailable === false) {
      reject(new Error("Tesseract nativo indisponível; usando o motor JavaScript."));
      return;
    }
    const cageOnly = label.startsWith("coluna-gaiola");
    const cageOptions = cageOnly
      ? ["-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"]
      : [];
    const commandArgs = [imagePath, "stdout", "-l", cageOnly ? "eng" : "por", "--oem", "1", "--psm", String(psm), ...cageOptions, "tsv"];
    execFile(
      "tesseract",
      commandArgs,
      { timeout: 15000, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") nativeTesseractAvailable = false;
          const failure = new Error(stderr?.trim() || error.message) as NodeJS.ErrnoException;
          failure.code = (error as NodeJS.ErrnoException).code;
          reject(failure);
          return;
        }

        nativeTesseractAvailable = true;
        const lines = parseTsvLines(stdout || "");
        resolve({
          text: lines.map((line) => line.text).join("\n"),
          lines,
          source: `tesseract-binary:${label}`
        });
      }
    );
  });
}

function readRouteImageOcrWithTesseractJs(imagePath: string, label: string, psm: number): Promise<RouteOcrResult> {
  const recognize = async (): Promise<RouteOcrResult> => {
    const cageOnly = label.startsWith("coluna-gaiola");
    const worker = await getTesseractJsWorker(cageOnly);
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm) as any
    });

    const result = await worker.recognize(
      imagePath,
      {},
      {
        text: true,
        blocks: true,
        tsv: true
      }
    );
    const tsvLines = parseTsvLines(result.data.tsv || "");
    const blockLines = tsvLines.length ? tsvLines : extractBlockLines(result.data.blocks || []);
    return {
      text: blockLines.map((line) => line.text).join("\n") || result.data.text || "",
      lines: blockLines,
      source: `tesseract-js:${label}`
    };
  };
  const pending = tesseractJsRecognitionQueue.then(recognize, recognize);
  tesseractJsRecognitionQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function detectCageColumnCrop(imagePath: string, sharp: any, fallbackWidth: number, fallbackHeight: number) {
  void imagePath;
  void sharp;
  return calculateCageColumnCrop(fallbackWidth, fallbackHeight, fallbackWidth, fallbackHeight);
}

async function detectRouteImageLayoutPreset(imagePath: string, sharp: any, meanLuminance: number): Promise<RouteImageLayoutPreset> {
  if (isDarkRouteImage(meanLuminance)) return "dark-modern";
  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize({ width: 480, withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = Number(info.channels || 3);
    const scanHeight = Math.max(1, Math.floor(Number(info.height || 1) * 0.25));
    let orange = 0;
    let samples = 0;
    for (let y = 0; y < scanHeight; y += 2) {
      for (let x = 0; x < Number(info.width || 1); x += 2) {
        const offset = (y * Number(info.width || 1) + x) * channels;
        const red = data[offset] || 0;
        const green = data[offset + 1] || 0;
        const blue = data[offset + 2] || 0;
        samples += 1;
        if (red >= 180 && green >= 35 && green <= 135 && blue <= 90 && red >= green * 1.6) orange += 1;
      }
    }
    return classifyRouteImageLayout(meanLuminance, samples ? orange / samples : 0);
  } catch {
    return classifyRouteImageLayout(meanLuminance, 0);
  }
}

async function createPreprocessedImages(imagePath: string, preferCageCrop = false, mode: "all" | "cage" | "full" = "all", maxVariants?: number) {
  const generatedPaths: string[] = [];
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(imagePath).metadata();
    const width = metadata.width || 0;
    if (!preferCageCrop) {
      // Neighborhood selection needs the entire row: the previous "full"
      // profile actually cropped ROTA + AT and discarded city/neighborhood.
      // WhatsApp often recompresses wide table screenshots until route letters
      // are only a few pixels wide. A 3x/Lanczos enlargement gives Tesseract
      // enough edge information to distinguish B from 8 without guessing.
      const completeWidth = width > 0 ? Math.min(1650, Math.max(1100, Math.round(width * 1.4))) : 1300;
      const base = path.join(os.tmpdir(), `ocr-neighborhood-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const contrast = `${base}-contrast.png`;
      const soft = `${base}-soft.png`;
      const binary = `${base}-binary.png`;
      const inverted = `${base}-dark-inverted.png`;
      const invertedBinary = `${base}-dark-inverted-binary.png`;
      const fullStats = await sharp(imagePath).rotate().grayscale().stats();
      const darkLayout = isDarkRouteImage(Number(fullStats.channels?.[0]?.mean));
      // Dark screenshots already have strong edge contrast after inversion.
      // Keeping fewer pixels makes Tesseract materially faster on the long
      // tables used by the current provider without blurring the numeric cells.
      const ocrWidth = darkLayout
        ? (width > 0 ? Math.min(1150, Math.max(760, Math.round(width * 0.95))) : 850)
        : completeWidth;
      const standardVariants = [
        { path: contrast, label: "bairros-tabela-completa-contraste", generated: true, psm: 6 },
        { path: contrast, label: "bairros-tabela-completa-esparsa", generated: false, psm: 11 },
        { path: soft, label: "bairros-tabela-completa-suave", generated: true, psm: 6 },
        { path: binary, label: "bairros-tabela-completa-binaria", generated: true, psm: 6 },
        { path: imagePath, label: "bairros-original", generated: false, psm: 11 }
      ];
      const orderedVariants = darkLayout ? [
        { path: inverted, label: "bairros-tabela-escura-invertida", generated: true, psm: 6 },
        { path: invertedBinary, label: "bairros-tabela-escura-binaria", generated: true, psm: 6 },
        ...standardVariants
      ] : standardVariants;
      const selectedVariants = orderedVariants.slice(0, Math.max(1, maxVariants || orderedVariants.length));
      const selectedPaths = new Set(selectedVariants.filter((variant) => variant.generated).map((variant) => variant.path));
      generatedPaths.push(...selectedPaths);
      const jobs = new Map<string, () => Promise<unknown>>([
        [contrast, () => sharp(imagePath).rotate().trim({ threshold: 10 }).resize({ width: ocrWidth }).grayscale().normalize()
          .sharpen({ sigma: 0.9, m1: 0.8, m2: 1.8 }).png().toFile(contrast)],
        [soft, () => sharp(imagePath).rotate().trim({ threshold: 10 }).resize({ width: ocrWidth }).grayscale().normalize()
          .linear(1.12, -8).sharpen({ sigma: 0.45 }).png().toFile(soft)],
        [binary, () => sharp(imagePath).rotate().trim({ threshold: 10 }).resize({ width: ocrWidth }).grayscale().normalize()
          .threshold(165).png().toFile(binary)],
        [inverted, () => sharp(imagePath).rotate().trim({ threshold: 10 }).resize({ width: ocrWidth }).grayscale().negate().normalize()
          .linear(1.08, -4).sharpen({ sigma: 0.75 }).png().toFile(inverted)],
        [invertedBinary, () => sharp(imagePath).rotate().trim({ threshold: 10 }).resize({ width: ocrWidth }).grayscale().negate().normalize()
          .threshold(150).png().toFile(invertedBinary)]
      ]);
      await Promise.all([...selectedPaths].map((selectedPath) => jobs.get(selectedPath)!()));
      return selectedVariants;
    }
    const resizeWidth = width > 0 ? Math.min(3200, Math.max(1800, width * 2)) : 2200;
    const baseName = path.join(os.tmpdir(), `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const enhancedPath = `${baseName}-enhanced.png`;
    const thresholdPath = `${baseName}-threshold.png`;
    const cageEnhancedPath = `${baseName}-cage-enhanced.png`;
    const cageSoftPath = `${baseName}-cage-soft.png`;
    const cageCompactPath = `${baseName}-cage-compact.png`;
    const cageOriginalPath = `${baseName}-cage-original.png`;
    const resizeHeight = metadata.width && metadata.height
      ? Math.max(1, Math.round((metadata.height / metadata.width) * resizeWidth))
      : 1200;
    const sourceWidth = metadata.width || resizeWidth;
    const sourceHeight = metadata.height || resizeHeight;
    const imageStats = await sharp(imagePath).rotate().grayscale().stats();
    const meanLuminance = Number(imageStats.channels?.[0]?.mean);
    const layoutPreset = await detectRouteImageLayoutPreset(imagePath, sharp, meanLuminance);
    const darkLayout = layoutPreset === "dark-modern";
    const cageCrop = calculatePresetRouteCrop(layoutPreset, sourceWidth, sourceHeight);
    const cageOriginalCrop = calculatePresetRouteAtCrop(layoutPreset, sourceWidth, sourceHeight);
    const cageBackground = darkLayout ? "black" : "white";
    const cagePipeline = () => {
      return sharp(imagePath).rotate().extract(cageCrop).grayscale();
    };
    const focusedTableWidth = calculateFocusedOcrWidth(cageOriginalCrop.width);
    const focusedTablePipeline = () => {
      return sharp(imagePath).rotate().extract(cageOriginalCrop);
    };

    const fullJobs = [
      () => focusedTablePipeline()
        .resize({ width: focusedTableWidth, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .linear(1.18, -8)
        .sharpen({ sigma: 1.05, m1: 1.05, m2: 2 })
        .png()
        .toFile(enhancedPath),
      () => focusedTablePipeline()
        .resize({ width: focusedTableWidth, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .sharpen({ sigma: 0.9 })
        .threshold(165)
        .png()
        .toFile(thresholdPath)
    ];
    const cageJobs = [
      () => cagePipeline()
        .resize({ width: cageCrop.width * 4, withoutEnlargement: false })
        .normalize()
        .sharpen({ sigma: 0.6 })
        .extend({ top: 24, bottom: 50, left: 24, right: 24, background: cageBackground })
        .png()
        .toFile(cageEnhancedPath),
      () => cagePipeline()
        .resize({ width: cageCrop.width * 4, withoutEnlargement: false })
        .normalize()
        .linear(1.12, -5)
        .extend({ top: 24, bottom: 50, left: 24, right: 24, background: cageBackground })
        .png()
        .toFile(cageSoftPath),
      () => cagePipeline()
        .resize({ width: cageCrop.width * 2, withoutEnlargement: false })
        .normalize()
        .sharpen({ sigma: 0.7 })
        .threshold(172)
        .extend({ top: 20, bottom: 40, left: 20, right: 20, background: cageBackground })
        .png()
        .toFile(cageCompactPath),
      () => sharp(imagePath)
        .rotate()
        .extract(cageOriginalCrop)
        .resize({ width: cageOriginalCrop.width * 2, withoutEnlargement: false })
        .extend({ top: 16, bottom: 32, left: 16, right: 16, background: cageBackground })
        .png()
        .toFile(cageOriginalPath)
    ];
    if (mode !== "cage") generatedPaths.push(enhancedPath, thresholdPath);
    if (mode !== "full") generatedPaths.push(cageEnhancedPath, cageSoftPath, cageCompactPath, cageOriginalPath);
    await Promise.all([
      ...(mode !== "cage" ? fullJobs.map((job) => job()) : []),
      ...(mode !== "full" ? cageJobs.map((job) => job()) : [])
    ]);

    const fullTableVariants = [
      { path: enhancedPath, label: `rota-at-${layoutPreset}-contraste`, generated: true, psm: 6 },
      { path: enhancedPath, label: `rota-at-${layoutPreset}-esparsa`, generated: false, psm: 11 },
      { path: thresholdPath, label: `rota-at-${layoutPreset}-preto-e-branco`, generated: true, psm: 6 },
    ];
    const cageColumnVariants = [
      { path: cageEnhancedPath, label: `coluna-gaiola-${layoutPreset}-4x`, generated: true, psm: 6 },
      { path: cageSoftPath, label: `coluna-gaiola-${layoutPreset}-4x-suave`, generated: true, psm: 6 },
      { path: cageCompactPath, label: `coluna-gaiola-${layoutPreset}-2x`, generated: true, psm: 6 },
      { path: cageOriginalPath, label: `coluna-gaiola-${layoutPreset}-at-2x-original`, generated: true, psm: 6 },
    ];
    const originalVariant = [
      { path: imagePath, label: "original", generated: false, psm: 11 }
    ];
    if (mode === "cage") return cageColumnVariants;
    if (mode === "full") return [...fullTableVariants, ...originalVariant];
    return preferCageCrop
      ? [...cageColumnVariants, ...fullTableVariants, ...originalVariant]
      : [
          // Perfil rápido comprovado no layout novo: texto esparso completo,
          // tabela binária e coluna binária compacta. Os demais ficam como
          // fallback e só rodam quando o consenso inicial for insuficiente.
          fullTableVariants[1],
          fullTableVariants[2],
          cageColumnVariants[2],
          fullTableVariants[0],
          cageColumnVariants[0],
          cageColumnVariants[1],
          cageColumnVariants[3],
          ...originalVariant
        ];
  } catch {
    for (const generatedPath of generatedPaths) {
      try {
        fs.rmSync(generatedPath, { force: true });
      } catch {
        // O arquivo temporário pode já ter sido removido.
      }
    }
    return [{ path: imagePath, label: "original", generated: false, psm: 6 }];
  }
}

function getTesseractJsWorker(_cageOnly = false) {
  // Todas as variantes usam português e são executadas em sequência.
  // Um worker único evita carregar duas cópias do mesmo modelo na memória.
  if (!tesseractJsWorkerPromise) {
    tesseractJsWorkerPromise = createWorker("por", 1, {
      logger: () => undefined
    }).catch((error) => {
      tesseractJsWorkerPromise = undefined;
      throw error;
    });
  }

  return tesseractJsWorkerPromise;
}

export async function warmupRouteOcrEngine() {
  await getTesseractJsWorker();
}

export async function shutdownRouteOcrEngine() {
  const currentWorker = tesseractJsWorkerPromise;
  tesseractJsWorkerPromise = undefined;
  if (!currentWorker) return;
  try {
    const worker = await currentWorker;
    await worker.terminate();
  } catch {
    // O processo pode ter caído antes de liberar o motor da IA.
  }
}

export function findConfiguredRouteCode(ocrText: string, routes: string[]) {
  return findConfiguredRouteCodeDetailed(ocrText, [], routes);
}

export function findConfiguredRouteCodeDetailed(ocrText: string, monitoredRoutes: MonitoredRoute[] = [], legacyRoutes: string[] = []) {
  const lines = ocrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return findConfiguredRouteCodeInLines(lines.map(createPlainOcrLine), monitoredRoutes, legacyRoutes);
}

export function findConfiguredRouteCodeFromOcr(ocr: RouteOcrResult, monitoredRoutes: MonitoredRoute[] = [], legacyRoutes: string[] = []) {
  const variants = ocr.variants?.length ? ocr.variants : [ocr];
  const detections = variants
    .map((variant) => {
      const lines = variant.lines.length
        ? variant.lines
        : variant.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(createPlainOcrLine);
      return findConfiguredRouteCodeInLines(lines, monitoredRoutes, legacyRoutes);
    })
    .filter(Boolean) as DetectedRouteCode[];

  return selectConsensusDetection(detections, variants.length);
}

export function findAllConfiguredRouteCodesFromOcr(
  ocr: RouteOcrResult,
  monitoredRoutes: MonitoredRoute[] = [],
  legacyRoutes: string[] = []
) {
  const results: DetectedRouteCode[] = [];
  const configuredDetailed = monitoredRoutes.filter((route) => route.bairro?.trim());

  for (const route of configuredDetailed) {
    const detected = findConfiguredRouteCodeFromOcr(ocr, [route], []);
    if (detected) results.push(detected);
  }

  const detailedNames = new Set(configuredDetailed.map((route) => normalizeOcrText(route.bairro)));
  for (const route of legacyRoutes.filter((item) => item.trim())) {
    if (detailedNames.has(normalizeOcrText(route))) continue;
    const detected = findConfiguredRouteCodeFromOcr(ocr, [], [route]);
    if (detected) results.push(detected);
  }

  const unique = new Map<string, DetectedRouteCode>();
  for (const detected of results) {
    const key = `${normalizeOcrText(detected.bairro || detected.route)}::${normalizeOcrText(detected.code)}`;
    const current = unique.get(key);
    if (!current || detected.confidence > current.confidence) unique.set(key, detected);
  }
  if (!configuredDetailed.length && !legacyRoutes.some((item) => item.trim())) {
    for (const detected of findAllGaiolaCodesFromOcr(ocr)) {
      const alreadyDetected = [...unique.values()].some((current) => normalizeOcrText(current.code) === normalizeOcrText(detected.code));
      if (!alreadyDetected) unique.set(`gaiola::${normalizeOcrText(detected.code)}`, detected);
    }
  }
  return [...unique.values()];
}

export function findAllGaiolaCodesFromOcr(ocr: RouteOcrResult) {
  const variants = ocr.variants?.length ? ocr.variants : [ocr];
  const byCode = new Map<string, Array<DetectedRouteCode & { variantIndex: number }>>();

  for (const [variantIndex, variant] of variants.entries()) {
    const sourceLines = variant.lines.length
      ? variant.lines
      : variant.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(createPlainOcrLine);
    const lines = mergeLikelySplitRows(sourceLines);
    const layout = getTableLayout(lines);
    for (const line of lines) {
      if (line.confidence < 35) continue;
      const columns = splitLineIntoRouteColumns(line, layout);
      const code = extractSafeGaiolaCode(line, columns.code) || extractSafeGaiolaCode(line) || extractMisreadLeadingICode(line.text);
      if (!code) continue;
      const detected: DetectedRouteCode = {
        route: "",
        code,
        plannedAt: extractPlannedAtCode(line.text),
        line: line.text,
        confidence: getGaiolaConfidence(line, code),
        evidenceCount: 1,
        variantCount: variants.length,
        safeForAutomatic: false
      };
      byCode.set(code, [...(byCode.get(code) || []), { ...detected, variantIndex }]);
    }

    const sourceWords = sourceLines.flatMap((line) => line.words);
    for (const word of sourceWords) {
      const code = extractStandaloneGaiolaCode(word.text);
      if (!code || word.confidence < 35) continue;
      const rowWords = sourceWords.filter((candidate) => {
        const verticalDistance = Math.abs((candidate.top + candidate.height / 2) - (word.top + word.height / 2));
        return verticalDistance <= Math.max(8, word.height * 0.7, candidate.height * 0.7);
      });
      const row = rowWords.length ? createOcrLineFromWords(rowWords) : createOcrLineFromWords([word]);
      const detected: DetectedRouteCode = {
        route: "",
        code,
        plannedAt: extractPlannedAtCode(row.text),
        line: row.text,
        confidence: Math.round(Math.min(word.confidence, row.confidence)),
        evidenceCount: 1,
        variantCount: variants.length,
        safeForAutomatic: false
      };
      byCode.set(code, [...(byCode.get(code) || []), { ...detected, variantIndex }]);
    }
  }

  return [...byCode.values()].map((matches) => {
    const best = [...matches].sort((left, right) => right.confidence - left.confidence)[0];
    const evidenceByVariant = new Map<number, DetectedRouteCode & { variantIndex: number }>();
    for (const match of matches.filter((item) => item.confidence >= 45)) {
      const current = evidenceByVariant.get(match.variantIndex);
      if (!current || match.confidence > current.confidence) evidenceByVariant.set(match.variantIndex, match);
    }
    const evidence = [...evidenceByVariant.values()];
    const { variantIndex: _variantIndex, ...cleanBest } = best;
    return {
      ...cleanBest,
      plannedAt: evidence.find((item) => item.plannedAt)?.plannedAt || cleanBest.plannedAt,
      confidence: evidence.length ? Math.round(Math.min(...evidence.map((item) => item.confidence))) : best.confidence,
      evidenceCount: evidence.length,
      variantCount: variants.length,
      safeForAutomatic: evidence.length >= 2
    };
  });
}

function extractStandaloneGaiolaCode(text: string) {
  const normalized = normalizeDuplicatedGaiolaLetter(normalizeOcrToken(text)).toUpperCase().replace(/[–—]/g, "-");
  const match = normalized.match(/^([A-Z|1])\s*([-.:]?)\s*(\d{1,2})$/);
  if (!match) return "";
  if (/[|1]/.test(match[1]) && !match[2]) return "";
  const letter = /[|1]/.test(match[1]) ? "I" : match[1];
  return `${letter}-${match[3]}`;
}

export function findConfiguredRouteInOcrLine(line: string, monitoredRoutes: MonitoredRoute[] = [], legacyRoutes: string[] = []) {
  const normalizedLine = ` ${normalizeOcrText(line)} `;
  const detailed = monitoredRoutes
    .filter((route) => route.bairro?.trim())
    .sort((left, right) => right.bairro.length - left.bairro.length)
    .find((route) => {
      const bairro = normalizeOcrText(route.bairro);
      return normalizedLine.includes(` ${bairro} `);
    });
  if (detailed) return { cidade: detailed.cidade.trim(), bairro: detailed.bairro.trim() };

  const legacy = legacyRoutes
    .filter((route) => route.trim())
    .sort((left, right) => right.length - left.length)
    .find((route) => normalizedLine.includes(` ${normalizeOcrText(route)} `));
  return legacy ? { cidade: "", bairro: legacy.trim() } : undefined;
}

export function findNeighborhoodInOcrLine(line: string, neighborhoods: string[]) {
  const normalizedLine = ` ${normalizeOcrText(line)} `;
  return neighborhoods
    .filter((bairro) => bairro.trim())
    .sort((left, right) => right.length - left.length)
    .find((bairro) => normalizedLine.includes(` ${normalizeOcrText(bairro)} `));
}

export function extractNeighborhoodAfterCity(line: string, city: string) {
  const normalizedLine = normalizeOcrText(line);
  const normalizedCity = normalizeOcrText(city);
  if (!normalizedLine || !normalizedCity) return "";
  const cityIndex = normalizedLine.lastIndexOf(normalizedCity);
  if (cityIndex < 0) return "";
  return normalizedLine.slice(cityIndex + normalizedCity.length).trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function selectConsensusDetection(detections: DetectedRouteCode[], variantCount: number) {
  if (!detections.length) return undefined;

  const groups = new Map<string, DetectedRouteCode[]>();
  for (const detection of detections) {
    const key = [detection.cidade, detection.bairro || detection.route, detection.code]
      .map((value) => normalizeOcrText(value || ""))
      .join("::");
    groups.set(key, [...(groups.get(key) || []), detection]);
  }

  const ranked = [...groups.values()].sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length;
    return averageConfidence(right) - averageConfidence(left);
  });
  const winner = ranked[0];
  const best = [...winner].sort((left, right) => right.confidence - left.confidence)[0];
  const competingCodes = new Set(detections.map((detection) => detection.code));
  const strongEvidence = winner.filter((detection) => detection.confidence >= 45);
  const confidence = strongEvidence.length
    ? Math.round(Math.min(...strongEvidence.map((detection) => detection.confidence)))
    : best.confidence;

  return {
    ...best,
    confidence,
    evidenceCount: strongEvidence.length,
    variantCount,
    safeForAutomatic: strongEvidence.length >= 2 && competingCodes.size === 1
  };
}

function averageConfidence(detections: DetectedRouteCode[]) {
  return detections.reduce((sum, detection) => sum + detection.confidence, 0) / Math.max(1, detections.length);
}

function findConfiguredRouteCodeInLines(lines: OcrLine[], monitoredRoutes: MonitoredRoute[] = [], legacyRoutes: string[] = []): DetectedRouteCode | undefined {
  const usefulLines = mergeLikelySplitRows(lines);
  const layout = getTableLayout(usefulLines);

  const normalizedDetailedRoutes = monitoredRoutes
    .map((route) => ({
      raw: route.cidade.trim() ? `${route.cidade.trim()} | ${route.bairro.trim()}` : route.bairro.trim(),
      cidade: route.cidade.trim(),
      bairro: route.bairro.trim(),
      normalizedCity: normalizeOcrText(route.cidade),
      normalizedDistrict: normalizeOcrText(route.bairro)
    }))
    .filter((route) => route.normalizedDistrict);

  const normalizedRoutes = legacyRoutes
    .map((route) => ({ raw: route.trim(), normalized: normalizeOcrText(route) }))
    .filter((route) => route.normalized);

  for (const route of normalizedDetailedRoutes) {
    for (const line of usefulLines) {
      if (line.confidence < 35) continue;
      const columns = splitLineIntoRouteColumns(line, layout);
      const normalizedCityColumn = normalizeOcrText(columns.city);
      const normalizedDistrictColumn = normalizeOcrText(columns.district);
      const normalizedLine = normalizeOcrText(line.text);
      const cityMatches = !route.normalizedCity ||
        matchesConfiguredText(normalizedCityColumn, route.normalizedCity) ||
        matchesConfiguredText(normalizedLine, route.normalizedCity);
      const districtMatches =
        matchesConfiguredText(normalizedDistrictColumn, route.normalizedDistrict) ||
        matchesConfiguredText(normalizedLine, route.normalizedDistrict) ||
        looselyMatchesRoute(normalizedLine, route.normalizedDistrict);
      if (!cityMatches || !districtMatches) continue;

      const gaiola = findGaiolaForRouteLine(line, usefulLines, columns.code);
      if (!gaiola) continue;

      return {
        route: route.raw,
        cidade: route.cidade,
        bairro: route.bairro,
        code: gaiola.code,
        line: gaiola.line,
        confidence: gaiola.confidence,
        evidenceCount: 1,
        variantCount: 1,
        safeForAutomatic: false
      };
    }
  }

  for (const line of usefulLines) {
    const normalizedLine = normalizeOcrText(line.text);
    if (!normalizedLine) continue;
    if (line.confidence < 45) continue;
    const columns = splitLineIntoRouteColumns(line, layout);

    for (const route of normalizedRoutes) {
      const routeIndex = normalizedLine.indexOf(route.normalized);
      if (routeIndex < 0 && !looselyMatchesRoute(normalizedLine, route.normalized)) continue;

      const beforeRoute = routeIndex >= 0 ? normalizedLine.slice(0, routeIndex) : "";
      const code = routeIndex >= 0
        ? extractOnlyGaiolaCode(beforeRoute)
        : extractSafeGaiolaCode(line, columns.code);
      if (!code) continue;

      return {
        route: route.raw,
        bairro: route.raw,
        code,
        line: line.text,
        confidence: getGaiolaConfidence(line, code),
        evidenceCount: 1,
        variantCount: 1,
        safeForAutomatic: false
      };
    }
  }

  return undefined;
}

function findGaiolaForRouteLine(routeLine: OcrLine, lines: OcrLine[], codeColumn: string) {
  const directCode = extractSafeGaiolaCode(routeLine, codeColumn) || extractSafeGaiolaCode(routeLine) || extractMisreadLeadingICode(routeLine.text);
  if (directCode) {
    return {
      code: directCode,
      line: routeLine.text,
      confidence: getGaiolaConfidence(routeLine, directCode)
    };
  }

  // O TSV do Tesseract pode criar duas linhas para uma única linha visual da
  // tabela: uma contendo a gaiola e outra contendo cidade/bairro. Associa
  // somente fragmentos muito próximos verticalmente e exige um único código,
  // evitando pegar a gaiola da rota vizinha.
  const medianHeight = median(lines.map((line) => line.height).filter((height) => height > 0)) || 18;
  const nearby = lines.filter((candidate) => {
    if (candidate === routeLine || candidate.confidence < 35) return false;
    const verticalDistance = Math.abs(centerY(candidate) - centerY(routeLine));
    if (verticalDistance > Math.max(14, medianHeight * 0.9)) return false;
    return candidate.left < routeLine.left || candidate.left < routeLine.left + routeLine.width * 0.25;
  });
  const candidates = nearby
    .map((candidate) => ({ candidate, code: extractSafeGaiolaCode(candidate) || extractMisreadLeadingICode(candidate.text) }))
    .filter((item) => item.code);
  const uniqueCodes = [...new Set(candidates.map((item) => item.code))];
  if (uniqueCodes.length !== 1) return undefined;

  const match = candidates.find((item) => item.code === uniqueCodes[0])!;
  return {
    code: match.code,
    line: `${match.candidate.text} | ${routeLine.text}`,
    confidence: Math.round(Math.min(
      routeLine.confidence,
      match.candidate.confidence,
      getGaiolaConfidence(match.candidate, match.code)
    ))
  };
}

function getTableLayout(lines: OcrLine[]) {
  const words = lines.flatMap((line) => line.words);
  if (!words.length) return { left: 0, right: 1000, width: 1000 };
  const left = Math.min(...words.map((word) => word.left));
  const right = Math.max(...words.map((word) => word.left + word.width));
  return { left, right, width: Math.max(1, right - left) };
}

function splitLineIntoRouteColumns(line: OcrLine, layout: { left: number; width: number }) {
  const words = [...line.words].sort((left, right) => left.left - right.left);
  const inRange = (start: number, end: number) => words
    .filter((word) => {
      const center = word.left + word.width / 2;
      const ratio = (center - layout.left) / layout.width;
      return ratio >= start && ratio < end;
    })
    .map((word) => word.text)
    .join(" ");

  return {
    code: inRange(0, 0.16),
    city: inRange(0.32, 0.82),
    district: inRange(0.58, 1.01)
  };
}

function matchesConfiguredText(line: string, expected: string) {
  if (line.includes(expected)) return true;
  const stopWords = new Set(["de", "da", "do", "das", "dos", "e"]);
  const expectedWords = expected.split(/\s+/).filter((word) => word.length > 1 && !stopWords.has(word));
  if (!expectedWords.length) return false;
  const lineWords = line.split(/\s+/).filter(Boolean);
  let cursor = 0;
  let matched = 0;

  for (const expectedWord of expectedWords) {
    const foundIndex = lineWords.findIndex((word, index) => index >= cursor && (
      word === expectedWord ||
      (expectedWord.length >= 4 && word.includes(expectedWord)) ||
      (word.length >= 4 && expectedWord.includes(word)) ||
      (expectedWord.length >= 4 && levenshteinDistance(word, expectedWord) <= Math.max(1, Math.ceil(expectedWord.length * 0.28)))
    ));
    if (foundIndex >= 0) {
      matched += 1;
      cursor = foundIndex + 1;
    }
  }

  if (expectedWords.length <= 2) return matched === expectedWords.length;
  return matched >= Math.max(2, Math.ceil(expectedWords.length * 0.66));
}

function parseTsvLines(tsv: string): OcrLine[] {
  const [headerLine, ...rows] = tsv.split(/\r?\n/).filter(Boolean);
  if (!headerLine) return [];

  const headers = headerLine.split("\t");
  const indexOf = (name: string) => headers.indexOf(name);
  const levelIndex = indexOf("level");
  const blockIndex = indexOf("block_num");
  const paragraphIndex = indexOf("par_num");
  const lineIndex = indexOf("line_num");
  const leftIndex = indexOf("left");
  const topIndex = indexOf("top");
  const widthIndex = indexOf("width");
  const heightIndex = indexOf("height");
  const confidenceIndex = indexOf("conf");
  const textIndex = indexOf("text");
  if ([levelIndex, blockIndex, paragraphIndex, lineIndex, leftIndex, topIndex, widthIndex, heightIndex, confidenceIndex, textIndex].some((index) => index < 0)) {
    return [];
  }

  const grouped = new Map<string, OcrWord[]>();
  for (const row of rows) {
    const columns = row.split("\t");
    if (columns[levelIndex] !== "5") continue;

    const text = (columns[textIndex] || "").trim();
    const confidence = Number(columns[confidenceIndex] || -1);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;

    const word: OcrWord = {
      text,
      left: Number(columns[leftIndex] || 0),
      top: Number(columns[topIndex] || 0),
      width: Number(columns[widthIndex] || 0),
      height: Number(columns[heightIndex] || 0),
      confidence
    };
    const key = `${columns[blockIndex]}:${columns[paragraphIndex]}:${columns[lineIndex]}`;
    grouped.set(key, [...(grouped.get(key) || []), word]);
  }

  return [...grouped.values()]
    .map(createOcrLineFromWords)
    .filter((line) => line.words.length && line.text)
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

function extractBlockLines(blocks: any[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const words = (line?.words || [])
          .map((word: any) => ({
            text: String(word?.text || "").trim(),
            left: Number(word?.bbox?.x0 || 0),
            top: Number(word?.bbox?.y0 || 0),
            width: Number(word?.bbox?.x1 || 0) - Number(word?.bbox?.x0 || 0),
            height: Number(word?.bbox?.y1 || 0) - Number(word?.bbox?.y0 || 0),
            confidence: Number(word?.confidence || 0)
          }))
          .filter((word: OcrWord) => word.text && Number.isFinite(word.confidence) && word.confidence >= 0);
        if (!words.length) continue;
        lines.push(createOcrLineFromWords(words));
      }
    }
  }
  return lines.sort((left, right) => left.top - right.top || left.left - right.left);
}

function createOcrLineFromWords(words: OcrWord[]): OcrLine {
  const sortedWords = [...words].sort((left, right) => left.left - right.left);
  const left = Math.min(...sortedWords.map((word) => word.left));
  const top = Math.min(...sortedWords.map((word) => word.top));
  const right = Math.max(...sortedWords.map((word) => word.left + word.width));
  const bottom = Math.max(...sortedWords.map((word) => word.top + word.height));
  return {
    text: sortedWords.map((word) => word.text).join(" "),
    words: sortedWords,
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    confidence: sortedWords.reduce((sum, word) => sum + word.confidence, 0) / sortedWords.length
  };
}

function createPlainOcrLine(text: string): OcrLine {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean).map((word, index) => ({
      text: word,
      left: index * 20,
      top: 0,
      width: Math.max(12, word.length * 8),
      height: 12,
      confidence: 100
    })),
    top: 0,
    left: 0,
    width: text.length * 8,
    height: 12,
    confidence: 100
  };
}

function mergeLikelySplitRows(lines: OcrLine[]) {
  if (lines.length < 2) return lines;

  const sorted = [...lines].sort((left, right) => left.top - right.top || left.left - right.left);
  const medianHeight = median(sorted.map((line) => line.height).filter((height) => height > 0)) || 18;
  const merged: OcrLine[] = [];

  for (const line of sorted) {
    const previous = merged[merged.length - 1];
    const sameRow = previous && Math.abs(centerY(previous) - centerY(line)) <= Math.max(8, medianHeight * 0.45);
    if (!sameRow) {
      merged.push(line);
      continue;
    }

    const words = [...previous.words, ...line.words].sort((left, right) => left.left - right.left);
    merged[merged.length - 1] = createOcrLineFromWords(words);
  }

  return merged;
}

function extractSafeGaiolaCode(line: OcrLine, codeText?: string) {
  if (codeText !== undefined) {
    const codeMatches = collectGaiolaCodes(normalizeOcrToken(codeText));
    return codeMatches.length === 1 ? codeMatches[0] : "";
  }
  if (collectGaiolaCodes(normalizeOcrToken(line.text)).length !== 1) return "";
  if (!line.words.length) return extractFirstGaiolaCodeBeforeRouteData(line.text);

  const sortedWords = [...line.words].sort((left, right) => left.left - right.left);
  const rowLeft = Math.min(...sortedWords.map((word) => word.left));
  const rowRight = Math.max(...sortedWords.map((word) => word.left + word.width));
  const maxCodeLeft = rowLeft + Math.max(80, (rowRight - rowLeft) * 0.22);
  const atIndex = sortedWords.findIndex((word) => /^at/i.test(normalizeOcrToken(word.text)));
  const codeWords = sortedWords.filter((word, index) => word.left <= maxCodeLeft && (atIndex < 0 || index < atIndex));
  const code = extractFirstGaiolaCodeBeforeRouteData(codeWords.map((word) => word.text).join(" "));
  return code || "";
}

function extractFirstGaiolaCodeBeforeRouteData(text: string) {
  const cleanText = normalizeOcrToken(text);
  const beforeAt = cleanText.split(/\bat\s*\d/i)[0] || cleanText;
  const matches = collectGaiolaCodes(beforeAt);
  return matches[0] || "";
}

function normalizeOcrToken(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[|()[\]{}]/g, " ")
    .trim();
}

function centerY(line: OcrLine) {
  return line.top + line.height / 2;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchesRoutePart(line: string, routePart: string) {
  return line.includes(routePart) || looselyMatchesRoute(line, routePart);
}

function extractOnlyGaiolaCode(text: string) {
  const matches = collectGaiolaCodes(text);
  return matches.length === 1 ? matches[0] : "";
}

function collectGaiolaCodes(text: string) {
  const matches = [...normalizeDuplicatedGaiolaLetter(text).matchAll(/\b([a-z])\s*[-.:]?\s*(\d{1,2})\b/gi)];
  return matches
    .map((match) => `${match[1] === "l" ? "I" : match[1].toUpperCase()}-${match[2]}`)
    .filter((code) => !/^AT-\d/i.test(code));
}

/**
 * Usa o Planned AT do romaneio como identidade definitiva da linha.
 *
 * O Tesseract pode ler I-17 como I-1 em um tratamento e corretamente em
 * outro. Somar os dois resultados sem considerar o AT faria o automático
 * preparar duas gaiolas. Quando o AT existe no romaneio, ele elimina essa
 * ambiguidade; quando não existe, conflitos desse tipo ficam inseguros para
 * o envio automático em vez de o bot tentar adivinhar.
 */
export function reconcileGaiolaDetectionsWithRomaneio(
  detections: DetectedRouteCode[],
  plannedAtCodes: string[],
  routes: RomaneioRouteSummary[]
) {
  const routesByAt = buildUniqueRoutesByPlannedAt(routes);
  const exactRoutes = plannedAtCodes
    .map((plannedAt) => routesByAt.get(normalizePlannedAtIdentity(plannedAt)))
    .filter((route): route is RomaneioRouteSummary => Boolean(route?.gaiola));
  const exactCodeKeys = new Set(exactRoutes.map((route) => normalizeGaiolaIdentity(route.gaiola)));

  const reconciled = detections.map((detected) => {
    const route = detected.plannedAt
      ? routesByAt.get(normalizePlannedAtIdentity(detected.plannedAt))
      : undefined;
    if (!route?.gaiola) return { ...detected };
    return detectionFromExactRomaneioRoute(detected, route, detected.plannedAt!);
  });

  for (const route of exactRoutes) {
    const codeKey = normalizeGaiolaIdentity(route.gaiola);
    if (reconciled.some((detected) => normalizeGaiolaIdentity(detected.code) === codeKey)) continue;
    reconciled.push(detectionFromExactRomaneioRoute(undefined, route, route.plannedAt || ""));
  }

  const withoutTruncatedI = reconciled.filter((detected) => {
    const codeKey = normalizeGaiolaIdentity(detected.code);
    if (exactCodeKeys.has(codeKey)) return true;
    // Com apenas um AT exato na imagem, I-1 ao lado de I-17 é a leitura
    // truncada da mesma linha. Não removemos prefixos em tabelas com vários
    // ATs porque I-1 e I-17 também podem ser duas linhas reais.
    return exactCodeKeys.size !== 1 || ![...exactCodeKeys].some((exactCode) =>
      isTruncatedLeadingICode(codeKey, exactCode));
  });

  const ambiguousCodes = findUnresolvedLeadingIConflicts(withoutTruncatedI, exactCodeKeys);
  const merged = new Map<string, DetectedRouteCode>();
  for (const detected of withoutTruncatedI) {
    const key = normalizeGaiolaIdentity(detected.code);
    // A letra I é visualmente igual a 1/l em várias fontes. Apenas códigos de
    // um dígito exigem AT: I-1 pode ser I-10..I-19 truncado. Códigos completos
    // como I-19/I-32 continuam válidos pelo consenso do OCR rápido.
    const needsExactLeadingIConfirmation = /^I-\d$/.test(key) && !exactCodeKeys.has(key);
    const candidate = ambiguousCodes.has(key) || needsExactLeadingIConfirmation
      ? { ...detected, safeForAutomatic: false }
      : detected;
    const current = merged.get(key);
    if (!current || candidate.confidence > current.confidence) {
      merged.set(key, current ? {
        ...candidate,
        plannedAt: candidate.plannedAt || current.plannedAt
      } : candidate);
      continue;
    }
    current.evidenceCount = Math.max(current.evidenceCount, candidate.evidenceCount);
    current.variantCount = Math.max(current.variantCount, candidate.variantCount);
    current.safeForAutomatic = current.safeForAutomatic || candidate.safeForAutomatic;
    current.plannedAt ||= candidate.plannedAt;
  }
  return [...merged.values()];
}

function buildUniqueRoutesByPlannedAt(routes: RomaneioRouteSummary[]) {
  const unique = new Map<string, RomaneioRouteSummary>();
  const ambiguous = new Set<string>();
  for (const route of routes) {
    const key = normalizePlannedAtIdentity(route.plannedAt || "");
    if (!key) continue;
    const current = unique.get(key);
    if (current && normalizeGaiolaIdentity(current.gaiola) !== normalizeGaiolaIdentity(route.gaiola)) {
      ambiguous.add(key);
      continue;
    }
    unique.set(key, route);
  }
  for (const key of ambiguous) unique.delete(key);
  return unique;
}

function detectionFromExactRomaneioRoute(
  detected: DetectedRouteCode | undefined,
  route: RomaneioRouteSummary,
  plannedAt: string
): DetectedRouteCode {
  return {
    route: route.rota,
    cidade: route.cidade,
    bairro: route.bairros[0]?.nome,
    code: route.gaiola,
    plannedAt: plannedAt || route.plannedAt,
    line: detected?.line || `${route.gaiola} ${plannedAt || route.plannedAt || ""}`.trim(),
    confidence: detected?.confidence || 100,
    evidenceCount: detected?.evidenceCount || 1,
    variantCount: detected?.variantCount || 1,
    safeForAutomatic: detected?.safeForAutomatic || false
  };
}

function normalizePlannedAtIdentity(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeGaiolaIdentity(value: string) {
  const match = String(value || "").trim().toUpperCase().match(/^([A-Z])-?(\d{1,2})$/);
  return match ? `${match[1]}-${match[2]}` : String(value || "").trim().toUpperCase();
}

function isTruncatedLeadingICode(shortCode: string, fullCode: string) {
  const shortMatch = shortCode.match(/^I-(\d{1,2})$/);
  const fullMatch = fullCode.match(/^I-(\d{1,2})$/);
  return Boolean(shortMatch && fullMatch &&
    shortMatch[1].length < fullMatch[1].length &&
    fullMatch[1].startsWith(shortMatch[1]));
}

function findUnresolvedLeadingIConflicts(detections: DetectedRouteCode[], exactCodeKeys: Set<string>) {
  const keys = [...new Set(detections.map((detected) => normalizeGaiolaIdentity(detected.code)))]
    .filter((code) => /^I-\d{1,2}$/.test(code));
  const ambiguous = new Set<string>();
  for (const left of keys) {
    for (const right of keys) {
      if (left === right || exactCodeKeys.has(left) || exactCodeKeys.has(right)) continue;
      if (isTruncatedLeadingICode(left, right) || isTruncatedLeadingICode(right, left)) {
        ambiguous.add(left);
        ambiguous.add(right);
      }
    }
  }
  return ambiguous;
}

export function findAllPlannedAtCodesFromOcr(ocr: RouteOcrResult) {
  const variants = ocr.variants?.length ? ocr.variants : [ocr];
  const values = variants.flatMap((variant) => {
    const source = `${variant.text}\n${variant.lines.map((line) => line.text).join("\n")}`.toUpperCase();
    return [...source.matchAll(/\bAT[0-9A-Z]{10,20}\b/g)].map((match) => match[0]);
  });
  return [...new Set(values)];
}

function extractPlannedAtCode(text: string) {
  return String(text || "").toUpperCase().match(/\bAT[0-9A-Z]{10,20}\b/)?.[0] || undefined;
}

function normalizeDuplicatedGaiolaLetter(text: string) {
  return String(text || "").replace(/\b([a-z])\1\s*([-.:])\s*(\d{1,2})\b/gi, "$1$2$3");
}

function extractMisreadLeadingICode(text: string) {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()[\]{}]/g, " ")
    .trim();
  const match = normalized.match(/^\s*[|1il]\s*-\s*(\d{1,2})\b/i);
  return match ? `I-${match[1]}` : "";
}

function getGaiolaConfidence(line: OcrLine, code: string) {
  const wanted = code.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const words = [...line.words].sort((left, right) => left.left - right.left);

  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= 3 && start + length <= words.length; length += 1) {
      const segment = words.slice(start, start + length);
      const compact = segment.map((word) => word.text).join("").replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (compact !== wanted) continue;
      return Math.round(Math.min(line.confidence, ...segment.map((word) => word.confidence)));
    }
  }

  return Math.round(Math.min(line.confidence, 50));
}

function looselyMatchesRoute(line: string, route: string) {
  const lineWords = line.split(/\s+/).filter((word) => word.length > 2);
  const routeWords = route.split(/\s+/).filter((word) => word.length > 2);
  if (!routeWords.length || !lineWords.length) return false;

  return routeWords.every((routeWord) =>
    lineWords.some((lineWord) => {
      if (lineWord.includes(routeWord) || routeWord.includes(lineWord)) return true;
      if (hasSameLetters(lineWord, routeWord)) return true;
      if (Math.abs(lineWord.length - routeWord.length) > Math.max(2, Math.floor(routeWord.length * 0.25))) return false;
      const maxDistance = Math.max(1, Math.floor(routeWord.length * 0.25));
      return levenshteinDistance(lineWord, routeWord) <= maxDistance;
    })
  );
}

function hasSameLetters(left: string, right: string) {
  if (left.length !== right.length || left.length < 5) return false;
  return left.split("").sort().join("") === right.split("").sort().join("");
}

function levenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insert = current[rightIndex] + 1;
      const remove = previous[rightIndex + 1] + 1;
      const replace = previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1);
      current.push(Math.min(insert, remove, replace));
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}
