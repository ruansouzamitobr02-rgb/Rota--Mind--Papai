import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import type { OcrWord, RouteOcrResult } from "./ocr";

type Anchor = { word: OcrWord; code: string; at: string };
type ImageVariant = { path: string; label: string };
const codeOf = (text: string) => {
  const match = text.trim().match(/^([MmNnIi1|l])\s*[-_–—:.]?\s*(\d{1,2})$/);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : undefined;
};
const sameRow = (a: OcrWord, b: OcrWord) => {
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap >= Math.min(a.height, b.height) * 0.45
    && Math.abs(a.top + a.height / 2 - b.top - b.height / 2) <= Math.max(a.height, b.height) * 0.6;
};

function anchors(reading: RouteOcrResult): Anchor[] {
  const words = reading.lines.flatMap(line => line.words || []);
  const ats = words.filter(word => /^AT[A-Z0-9]{8,}$/i.test(word.text));
  return words.flatMap(word => {
    const code = codeOf(word.text);
    if (!code) return [];
    const candidates = ats.filter(at => at.left > word.left + word.width && sameRow(word, at));
    return candidates.length === 1 ? [{ word, code, at: candidates[0].text.toUpperCase() }] : [];
  });
}

/** Re-read just the route cells, never a different row or a guessed M/N alias. */
export async function verifyAmbiguousCageLetters(
  readings: RouteOcrResult[], variants: ImageVariant[],
  readColumn: (file: string, label: string, psm: number) => Promise<RouteOcrResult>
) {
  const all = readings.map(anchors);
  const contradictory = new Set<string>();
  const seen = new Map<string, Set<string>>();
  for (const item of all.flat()) {
    const codes = seen.get(item.at) || new Set<string>(); codes.add(item.code); seen.set(item.at, codes);
    if (codes.size > 1) contradictory.add(item.at);
  }
  const index = all.findIndex(items => items.some(item => /^[MN]-/.test(item.code) && (item.word.confidence < 85 || contradictory.has(item.at))));
  if (index < 0) return { verified: 0, conflicts: 0 };
  const reading = readings[index], items = all[index];
  const image = variants.find(variant => reading.source.endsWith(`:${variant.label}`));
  const words = reading.lines.flatMap(line => line.words || []);
  const header = words.find(word => /^(ROTA|GAIOLA)$/i.test(word.text));
  const atHeader = header && words.find(word => /^AT$/i.test(word.text) && word.left > header.left && sameRow(word, header));
  if (!image || !header || !atHeader || !items.length) return { verified: 0, conflicts: 0 };
  // The first treatment may read 1-22 while another reads M-22. Include the
  // ambiguous cell only when a genuine M/N anchor has the exact same AT;
  // otherwise a real I-22 must never be reinterpreted as M/N.
  const mnAts = new Set(all.flat().filter(item => /^[MN]-/.test(item.code)).map(item => item.at));
  const candidates = items.filter(item => mnAts.has(item.at) && item.word.left < atHeader.left && item.word.top > header.top + header.height);
  if (!candidates.length) return { verified: 0, conflicts: 0 };
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(image.path).metadata();
  const left = Math.max(0, Math.floor(Math.min(header.left, ...candidates.map(item => item.word.left)) - 12));
  const right = Math.min(metadata.width || 0, Math.floor(atHeader.left - 12));
  const top = Math.max(0, Math.floor(Math.min(...candidates.map(item => item.word.top)) - 12));
  const bottom = Math.min(metadata.height || 0, Math.ceil(Math.max(...candidates.map(item => item.word.top + item.word.height)) + 12));
  if (right - left < 20 || bottom - top < 15) return { verified: 0, conflicts: 0 };
  const width = Math.min(800, Math.max(500, (right - left) * 2));
  const scale = width / (right - left);
  const base = path.join(os.tmpdir(), `ocr-mn-${randomUUID()}`);
  const files = [`${base}-soft.png`, `${base}-binary.png`];
  let verified = 0, conflicts = 0;
  try {
    const crop = await sharp(image.path).extract({ left, top, width: right - left, height: bottom - top })
      .resize({ width }).removeAlpha().grayscale().normalize().png().toBuffer();
    await sharp(crop).png().toFile(files[0]);
    await sharp(crop).threshold(165).png().toFile(files[1]);
    // The normal recognizer owns CPU admission and the JS worker mutex.
    const attempts = await Promise.allSettled(files.map((file, i) => readColumn(file, `coluna-gaiola-mn-${i}`, 6)));
    if (attempts.some(result => result.status === "rejected")) return { verified, conflicts };
    const checks = attempts.map(result => (result as PromiseFulfilledResult<RouteOcrResult>).value);
    for (const candidate of candidates) {
      const found = checks.map(check => check.lines.flatMap(line => {
        const match = line.text.toUpperCase().match(/^\s*([MN])\s*[-_–—:.]?\s*(\d{1,2})\s*$/);
        if (!match) return [];
        const mapped = { ...candidate.word, top: top + line.top / scale, height: line.height / scale };
        return sameRow(candidate.word, mapped) ? [{ code: `${match[1]}-${match[2]}`, confidence: line.confidence }] : [];
      }));
      if (found.some(items => items.length !== 1)) continue;
      const [first, second] = found.map(items => items[0]);
      const confirmed = first.code === second.code && first.code.slice(1) === candidate.code.slice(1);
      const rowAnchors = all.flat().filter(item => item.at === candidate.at && item.code.slice(1) === candidate.code.slice(1));
      if (confirmed) {
        for (const anchor of rowAnchors) {
          anchor.word.verifiedCageCode = first.code;
          anchor.word.cageVerificationConfidence = Math.min(first.confidence, second.confidence);
        }
        verified++;
      } else {
        for (const anchor of rowAnchors) anchor.word.cageLetterConflict = true;
        conflicts++;
      }
    }
    return { verified, conflicts };
  } finally {
    for (const file of files) try { fs.rmSync(file, { force: true }); } catch { /* Temporary image cleanup only. */ }
  }
}
