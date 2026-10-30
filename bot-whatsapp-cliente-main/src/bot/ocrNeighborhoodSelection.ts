import type { MonitoredRoute } from "../shared/types";
import type { DetectedRouteCode, OcrLine, RouteOcrResult } from "./ocr";
import { isCentroNeighborhood } from "../shared/neighborhoodRegion";

export type NeighborhoodSelection = {
  status: "selected" | "no-match" | "unsafe" | "unconfigured";
  detection?: DetectedRouteCode;
  preferenceIndex?: number;
  reason: string;
  detections: DetectedRouteCode[];
  selections: { detection: DetectedRouteCode; preferenceIndex: number }[];
};

type Row = { text: string; words: OcrLine["words"]; confidence: number; districtText?: string; localityText?: string; trailingCellText?: string; paradas?: number; pacotes?: number };
type Match = { row: Row; code: string; confidence: number; variant: number; regiao?: string; paradas?: number; pacotes?: number; requiresThreeEvidence?: boolean };

export function findManualRouteCandidatesFromOcr(ocr: RouteOcrResult): DetectedRouteCode[] {
  const variants = ocr.variants?.length ? ocr.variants : [ocr];
  const found = new Map<string, Array<DetectedRouteCode & { variant: number }>>();
  for (const [variant, reading] of variants.entries()) {
    for (const row of readRows(reading)) {
      const exact = [...row.text.matchAll(/(?:^|[\s|;])([A-Z])[-_\u2013\u2014:.\s]*(\d{1,2})(?=$|[\s|;,])/g)];
      const misreadFour = [...row.text.matchAll(/(?:^|[\s|;])([A-Z])[-_\u2013\u2014:.\s]*(\d)\s*[uU](?=$|[\s|;,])/g)];
      const codes = new Set([
        ...exact.map((match) => `${match[1].toUpperCase()}-${match[2]}`),
        ...misreadFour.map((match) => `${match[1].toUpperCase()}-${match[2]}4`)
      ]);
      if (codes.size !== 1) continue;
      const code = [...codes][0];
      const bairro = String(row.districtText || row.trailingCellText || "").trim();
      const regiao = bairro ? matchPreference(row, { cidade: "", bairro })?.regiao : row.localityText;
      const detection: DetectedRouteCode & { variant: number } = {
        route: bairro || row.text,
        cidade: String(row.localityText || "").trim() || undefined,
        bairro: bairro || undefined,
        ...(regiao ? { regiao } : {}),
        ...extractQuantitiesAfterAt(row),
        code,
        line: row.text,
        confidence: Math.round(Math.max(0, Math.min(100, row.confidence))),
        evidenceCount: 1,
        variantCount: variants.length,
        safeForAutomatic: false,
        variant
      };
      found.set(code, [...(found.get(code) || []), detection]);
    }
  }
  return [...found.values()].map((matches) => {
    const best = [...matches].sort((left, right) => right.confidence - left.confidence)[0];
    const { variant: _variant, ...candidate } = best;
    return { ...candidate, evidenceCount: new Set(matches.map((match) => match.variant)).size };
  }).sort((left, right) => right.evidenceCount - left.evidenceCount || right.confidence - left.confidence);
}

export function normalizeNeighborhoodIdentity(value: string) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeRegionIdentity(value: string) {
  return normalizeNeighborhoodIdentity(value)
    .replace(/^campos dos goytacazes(?= |$)/, "campos")
    .replace(/^sao joao da barra(?= |$)/, "sjb")
    .replace(/^sao francisco de itabapoana(?= |$)/, "sfi");
}

function regionBeforeDistrict(tail: string, district: string) {
  const normalizedDistrict = normalizeNeighborhoodIdentity(district);
  if (!normalizeNeighborhoodIdentity(tail).endsWith(` ${normalizedDistrict}`)) return undefined;
  const words = [...tail.matchAll(/[\p{L}\p{N}]+/gu)];
  const districtStart = words[words.length - normalizedDistrict.split(" ").length]?.index;
  if (districtStart === undefined) return undefined;
  return tail.slice(0, districtStart).replace(/[\s|;,:\-\u2013\u2014]+$/, "").trim() || undefined;
}

/**
 * Older configurations sometimes stored the CLUSTER label in the bairro
 * field (for example "Campos - Flamboyant"). Screenshots with a BAIRRO
 * column expose only "Flamboyant", so compare the actual neighborhood while
 * retaining legitimate names such as "Jardins de Campos" untouched.
 */
export function canonicalConfiguredNeighborhood(value: string) {
  const compact = String(value || "").trim().replace(/\s+/g, " ");
  const withoutKnownCityPrefix = compact.replace(
    /^(?:Campos(?:\s+dos\s+Goytacazes)?|SJB|S[aã]o\s+Jo[aã]o\s+da\s+Barra|SFI|S[aã]o\s+Francisco\s+de\s+Itabapoana)\s*[-\u2013\u2014|:]\s*/i,
    ""
  ).trim();
  return withoutKnownCityPrefix || compact;
}

/**
 * Selection deliberately does not use fuzzy matching or the romaneio. A row
 * must contain the complete configured neighborhood and optional region, and two OCR
 * treatments must agree on its literal cage code. Uncertainty in a preferred
 * neighborhood blocks selection instead of silently choosing a lower priority.
 */
export function selectPreferredNeighborhoodFromOcr(
  ocr: RouteOcrResult,
  preferences: MonitoredRoute[],
  maxStops = 0,
  maxPackages = 0,
  choiceMode: "preference" | "quantity" = "quantity",
  choiceMetric: "stops" | "packages" = "stops"
): NeighborhoodSelection {
  const configured = preferences.map((preference, index) => ({
    cidade: String(preference.cidade || "").trim(),
    bairro: canonicalConfiguredNeighborhood(preference.bairro),
    regiao: isCentroNeighborhood(preference.bairro) ? String(preference.regiao || "").trim() : "",
    index,
    enabled: preference.enabled !== false,
    conditionMetric: preference.conditionMetric,
    conditionMax: Math.max(0, Math.floor(Number(preference.conditionMax) || 0))
  })).filter((preference) => preference.enabled && normalizeNeighborhoodIdentity(preference.bairro));
  if (!configured.length) return { status: "unconfigured", reason: "Nenhum bairro preferido configurado.", detections: [], selections: [] };

  const variants = ocr.variants?.length ? ocr.variants : [ocr];
  const rows = variants.map(readRows);
  const detections: DetectedRouteCode[] = [];
  const selections: NeighborhoodSelection["selections"] = [];
  const selectedCodes = new Set<string>();
  const normalizedMaxStops = Number.isFinite(Number(maxStops)) ? Math.max(0, Math.floor(Number(maxStops))) : 0;
  const normalizedMaxPackages = Number.isFinite(Number(maxPackages)) ? Math.max(0, Math.floor(Number(maxPackages))) : 0;
  let firstFailure: Omit<NeighborhoodSelection, "detections" | "selections"> | undefined;

  for (const preference of configured) {
    const matches: Match[] = [];
    const regionConflicts = new Set<string>();
    for (const [variant, variantRows] of rows.entries()) {
      // A neighborhood can legitimately have multiple cages. Read every row
      // so the product can choose the cage with fewer stops instead of merely
      // choosing the first occurrence in the screenshot.
      for (const row of variantRows) {
        const match = matchPreference(row, preference);
        if (match) matches.push({ row, ...match, variant });
        else if (preference.regiao) {
          const otherRegion = matchPreference(row, preference, true);
          if (otherRegion?.code && otherRegion.regiao && otherRegion.confidence >= 65
            && normalizeRegionIdentity(otherRegion.regiao) !== normalizeRegionIdentity(preference.regiao)) {
            regionConflicts.add(otherRegion.code);
          }
        }
      }
    }
    if (!matches.length) continue;

    // Sparse OCR can visit a later occurrence of the same neighborhood first.
    // A weak isolated code must not veto the strong consensus for the first
    // visual row; conflicting cages still block when they reach this same
    // confidence floor.
    const codes = [...new Set(matches.filter((match) => match.confidence >= 65)
      .map((match) => match.code).filter(Boolean))];
    const incomplete = matches.some((match) => !match.code);
    const byCode = codes.map((code) => {
      const matching = matches.filter((match) => match.code === code);
      const strong = matching.filter((match) => match.confidence >= 65);
      const evidence = new Map<number, Match>();
      for (const match of strong) {
        const current = evidence.get(match.variant);
        if (!current || match.confidence > current.confidence) evidence.set(match.variant, match);
      }
      const confirmed = [...evidence.values()];
      const best = [...matching].sort((left, right) => right.confidence - left.confidence)[0];
      // A treatment can read a letter-shaped cage (for example G-2) as a
      // digit (6-2). An incomplete reading must not veto the normal consensus
      // of two independent treatments. A second valid, conflicting cage is
      // still represented in `codes` and blocks the automatic send.
      const requiredEvidence = matching.some((match) => match.requiresThreeEvidence) ? 3 : 2;
      const stops = mostFrequentNumber(confirmed.map((match) => match.paradas).filter((value): value is number => value !== undefined));
      const packages = mostFrequentNumber(confirmed.map((match) => match.pacotes).filter((value): value is number => value !== undefined));
      const structuralSingleReading = !preference.regiao && confirmed.length === 1 && !best.requiresThreeEvidence && best.confidence >= 65 &&
        (best.row.districtText !== undefined || best.row.trailingCellText !== undefined) &&
        (stops !== undefined || packages !== undefined);
      const detection: DetectedRouteCode = {
        route: preference.bairro,
        cidade: best.row.localityText,
        bairro: preference.bairro,
        ...(best.regiao ? { regiao: best.regiao } : {}),
        paradas: stops,
        pacotes: packages,
        code,
        line: best.row.text,
        confidence: confirmed.length ? Math.round(Math.min(...confirmed.map((match) => match.confidence))) : best.confidence,
        evidenceCount: evidence.size,
        variantCount: variants.length,
        safeForAutomatic: !regionConflicts.has(code) && (evidence.size >= requiredEvidence || structuralSingleReading)
      };
      return detection;
    });
    detections.push(...byCode);
    const safeCandidates = byCode.filter((candidate) => candidate.safeForAutomatic);
    // A code seen by only one of several OCR treatments may be a conflicting
    // reading of the same row. Keep blocking that ambiguity. When every code
    // is independently safe, they are real separate cages for this bairro.
    const hasUnconfirmedConflict = variants.length > 1 && byCode.some((candidate) => !candidate.safeForAutomatic);
    const candidateWithinLimits = (candidate: DetectedRouteCode) => {
      if (normalizedMaxStops && candidate.paradas !== undefined && candidate.paradas > normalizedMaxStops) return false;
      if (normalizedMaxPackages && candidate.pacotes !== undefined && candidate.pacotes > normalizedMaxPackages) return false;
      if (preference.conditionMax) {
        const value = preference.conditionMetric === "packages" ? candidate.pacotes : candidate.paradas;
        if (value !== undefined && value > preference.conditionMax) return false;
      }
      return true;
    };
    const eligibleCandidates = safeCandidates.filter(candidateWithinLimits);
    const candidatesToRank = eligibleCandidates.length ? eligibleCandidates : safeCandidates;
    const detection = hasUnconfirmedConflict ? undefined : [...candidatesToRank].sort((left, right) => {
      const metric = choiceMode === "quantity" ? choiceMetric : "stops";
      const leftValue = metric === "packages" ? left.pacotes : left.paradas;
      const rightValue = metric === "packages" ? right.pacotes : right.paradas;
      if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) return leftValue - rightValue;
      if (leftValue !== undefined) return -1;
      if (rightValue !== undefined) return 1;
      return byCode.indexOf(left) - byCode.indexOf(right);
    })[0];
    if (detection) {
      if (!selectedCodes.has(detection.code)) {
        selectedCodes.add(detection.code);
        selections.push({ preferenceIndex: preference.index, detection });
      }
    } else if (!firstFailure) {
      firstFailure = { status: "unsafe", preferenceIndex: preference.index,
        reason: regionConflicts.size ? "As leituras divergem sobre a região do bairro. Envio automático bloqueado."
          : codes.length > 1 ? "O bairro prioritário aparece associado a gaiolas diferentes. Envio bloqueado."
          : incomplete ? "O bairro prioritário foi encontrado sem uma gaiola inequívoca na mesma linha. Envio bloqueado."
            : "O bairro prioritário não obteve duas leituras confiáveis da mesma gaiola. Envio bloqueado." };
    }
  }
  if (selections.length) {
    const exceedsIndividualCondition = (item: NeighborhoodSelection["selections"][number]) => {
      const preference = configured.find((candidate) => candidate.index === item.preferenceIndex);
      if (!preference?.conditionMax) return false;
      const value = preference.conditionMetric === "packages" ? item.detection.pacotes : item.detection.paradas;
      return value !== undefined && value > preference.conditionMax;
    };
    const eligibleSelections = selections.filter((item) =>
      (!normalizedMaxStops || item.detection.paradas === undefined || item.detection.paradas <= normalizedMaxStops) &&
      (!normalizedMaxPackages || item.detection.pacotes === undefined || item.detection.pacotes <= normalizedMaxPackages) &&
      !exceedsIndividualCondition(item));
    const excludedCount = selections.length - eligibleSelections.length;
    const describeBlockedRoute = (item: NeighborhoodSelection["selections"][number]) => {
      const { detection } = item;
      const preference = configured.find((candidate) => candidate.index === item.preferenceIndex);
      const violations: string[] = [];
      if (normalizedMaxStops && detection.paradas !== undefined && detection.paradas > normalizedMaxStops) {
        violations.push(`${detection.paradas} paradas acima do limite geral de ${normalizedMaxStops}`);
      }
      if (normalizedMaxPackages && detection.pacotes !== undefined && detection.pacotes > normalizedMaxPackages) {
        violations.push(`${detection.pacotes} pacotes acima do limite geral de ${normalizedMaxPackages}`);
      }
      if (preference?.conditionMax && exceedsIndividualCondition(item)) {
        const metric = preference.conditionMetric === "packages" ? "pacotes" : "paradas";
        violations.push(`${metric === "pacotes" ? detection.pacotes : detection.paradas} ${metric} acima da condição desse bairro (${preference.conditionMax})`);
      }
      return `${detection.code}: ${detection.bairro}${detection.regiao ? ` / ${detection.regiao}` : ""} confirmado${detection.regiao ? "s" : ""}; bloqueio por ${violations.join("; ")}.`;
    };
    if (!eligibleSelections.length) return {
      status: "unsafe",
      reason: `Encontrei rotas para suas preferências, mas os limites de quantidade bloquearam o envio automático. ${selections.map(describeBlockedRoute).join(" ")} Revise os limites nas preferências. Nenhuma mensagem foi enviada.`,
      detections,
      selections: []
    };
    const orderedSelections = [...eligibleSelections].sort((left, right) => {
      if (choiceMode === "preference") return left.preferenceIndex - right.preferenceIndex;
      const leftValue = choiceMetric === "packages" ? left.detection.pacotes : left.detection.paradas;
      const rightValue = choiceMetric === "packages" ? right.detection.pacotes : right.detection.paradas;
      if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) return leftValue - rightValue;
      if (leftValue !== undefined) return -1;
      if (rightValue !== undefined) return 1;
      return left.preferenceIndex - right.preferenceIndex;
    });
    return {
      status: "selected", detection: orderedSelections[0].detection, preferenceIndex: orderedSelections[0].preferenceIndex,
      reason: `${orderedSelections.length} bairro(s) liberado(s), seguindo ${choiceMode === "preference" ? "a ordem de preferência" : `o menor número de ${choiceMetric === "packages" ? "pacotes" : "paradas"}`}${normalizedMaxStops || normalizedMaxPackages ? ` e respeitando ${formatLimits(normalizedMaxStops, normalizedMaxPackages)}` : ""}.${excludedCount ? ` ${excludedCount} rota(s) acima do limite foram descartadas; a próxima preferência elegível foi usada.` : ""}`,
      detections, selections: orderedSelections
    };
  }
  return firstFailure ? { ...firstFailure, detections, selections }
    : { status: "no-match", reason: configured.some((item) => item.regiao)
      ? "Nenhuma linha confirmou o bairro e a região configurados na mesma rota."
      : "Nenhuma linha corresponde exatamente aos bairros configurados.", detections, selections };
}

function matchPreference(row: Row, preference: MonitoredRoute, ignoreRegion = false) {
  // Underlined route links are commonly read as H_31, H 31 or H31. Accept
  // those shapes only for a real letter followed by 1-2 digits. Never turn
  // 1/l/|/II into I or truncate a three-digit value.
  const codeMatches = [...row.text.matchAll(/(?:^|[\s|;])([A-Z])[-_\u2013\u2014:.\s]*(\d{1,2})(?=$|[\s|;,])/g)];
  const suspiciousCodes = [...row.text.matchAll(/(?:^|[\s|;])([1|]|II|l|i)\s*[-_\u2013\u2014:.]\s*(\d{1,3})(?=$|[\s|;,])/g)];
  const misreadFourCodes = [...row.text.matchAll(/(?:^|[\s|;])([A-Z])[-_\u2013\u2014:.\s]*(\d)\s*[uU](?=$|[\s|;,])/g)];
  let code = codeMatches.length === 1 && suspiciousCodes.length === 0
    ? `${codeMatches[0][1].toUpperCase()}-${codeMatches[0][2]}` : "";
  // In the narrow route column Tesseract frequently reads I-24 as 1-24,
  // l-24 or |-24. Recover only a two-digit I route when the same physical row
  // also contains a complete AT identifier; consensus across OCR treatments is
  // still required before automatic dispatch.
  const suspiciousPrefix = suspiciousCodes.length === 1 ? suspiciousCodes[0][1] : "";
  const hasExactAt = /\bAT[A-Z0-9]{8,}\b/i.test(row.text);
  const malformedSingleI = row.text.match(/(?:^|[\s|;])(-{1,2}\s*(\d))(?=$|[\s|;,])/);
  let requiresThreeEvidence = false;
  // In compressed screenshots the open top of the final digit 4 is often
  // recognized as "u" (F-24 -> F-2u). Recover it only beside a complete AT;
  // city/neighborhood matching and two independent OCR readings are still
  // required before this code can be sent automatically.
  if (!code && hasExactAt && misreadFourCodes.length === 1 && suspiciousCodes.length === 0) {
    code = `${misreadFourCodes[0][1].toUpperCase()}-${misreadFourCodes[0][2]}4`;
  }
  if (!code && hasExactAt && /^[1|li]$/i.test(suspiciousPrefix) && suspiciousCodes[0][2].length === 2) {
    code = `I-${suspiciousCodes[0][2]}`;
  }
  if (!code && hasExactAt && malformedSingleI) {
    code = `I-${malformedSingleI[2]}`;
    requiresThreeEvidence = true;
  }
  const lastCode = codeMatches[codeMatches.length - 1];
  const recoveredCodeEnd = malformedSingleI?.index !== undefined
    ? malformedSingleI.index + malformedSingleI[0].length : undefined;
  const misreadFourCode = misreadFourCodes.length === 1 ? misreadFourCodes[0] : undefined;
  const misreadFourCodeEnd = misreadFourCode?.index !== undefined
    ? misreadFourCode.index + misreadFourCode[0].length : undefined;
  let tail = lastCode ? row.text.slice(lastCode.index! + lastCode[0].length)
    : misreadFourCodeEnd !== undefined ? row.text.slice(misreadFourCodeEnd)
      : recoveredCodeEnd !== undefined ? row.text.slice(recoveredCodeEnd) : row.text;
  // Strip an unreadable cage only to record unsafe evidence for this preference.
  // It must never become the code used for a message.
  if (!lastCode && misreadFourCodeEnd === undefined) tail = tail.replace(/^\s*[A-Za-z1|]{1,2}\s*[-_\u2013\u2014:.]?\s*\d{1,3}\b/, "");
  tail = stripMetadata(tail);
  const regiao = row.localityText !== undefined ? row.localityText.trim() : regionBeforeDistrict(tail, preference.bairro);
  if (preference.regiao && !ignoreRegion && (!regiao || normalizeRegionIdentity(regiao) !== normalizeRegionIdentity(preference.regiao))) return undefined;
  if (preference.regiao && !ignoreRegion && row.districtText === undefined
    && normalizeNeighborhoodIdentity(row.trailingCellText || "") !== normalizeNeighborhoodIdentity(preference.bairro)) return undefined;
  const city = normalizeNeighborhoodIdentity(preference.cidade);
  const district = normalizeNeighborhoodIdentity(preference.bairro);
  const normalizedTail = normalizeNeighborhoodIdentity(tail);
  const leadingCity = city ? findLeadingCityAlias(normalizedTail, city) : undefined;
  const cityQualifiedDistricts = city ? findCityQualifiedDistricts(tail, city) : [];
  if (cityQualifiedDistricts.includes(`${district} ${district}`)) {
    // In compact captures CLUSTER ("Campos - Parque Aurora") and BAIRRO
    // ("Parque Aurora") can be fused into one OCR line. Accept only when the
    // complete configured neighborhood is repeated exactly after the city.
    tail = preference.bairro;
  } else if (row.districtText !== undefined) {
    tail = row.districtText;
  } else if (!city && row.trailingCellText !== undefined) {
    // Headerless exports still preserve column geometry. When the client did
    // not configure a city, compare only the physically isolated last cell;
    // this accepts "Centro" but never the suffix of "Novo Centro".
    const trailingDistrict = normalizeNeighborhoodIdentity(row.trailingCellText);
    const fullTail = normalizeNeighborhoodIdentity(tail);
    const prefix = fullTail.endsWith(` ${district}`)
      ? fullTail.slice(0, -district.length).trim().split(/\s+/).pop()
      : undefined;
    tail = trailingDistrict === district || (prefix && prefix !== "novo" && prefix !== "nova")
      ? preference.bairro : row.trailingCellText;
  } else if (
    city && row.trailingCellText !== undefined &&
    normalizeNeighborhoodIdentity(row.trailingCellText) === district &&
    cityQualifiedDistricts.length > 0
  ) {
    // Headerless exports can add/remove numeric columns while keeping a clear
    // final BAIRRO cell. Accept it only when the configured city is also
    // present as a complete identity elsewhere in the same physical row.
    tail = row.trailingCellText;
  } else if (cityQualifiedDistricts.includes(district)) {
    // Some exports have no BAIRRO column and put one or more explicit
    // "city - neighborhood" pairs in CLUSTER. Select only a complete pair;
    // never use a substring from another city or a similar neighborhood.
    tail = preference.bairro;
  } else if (city && leadingCity) {
    // The city must be complete and immediately precede the neighborhood data.
    // Retain real separators between multiple explicitly listed neighborhoods.
    const tokens = leadingCity.split(" ").length;
    tail = removeLeadingPlaceTokens(tail, tokens);
  } else if (city && hasExplicitCityDistrictPair(tail, city, district)) {
    tail = preference.bairro;
  } else if (!city && normalizedTail.endsWith(` ${district}`)) {
    const prefix = normalizedTail.slice(0, -district.length).trim().split(/\s+/).pop();
    if (prefix === "novo" || prefix === "nova") return undefined;
    tail = preference.bairro;
  } else if (normalizeNeighborhoodIdentity(tail) !== district) {
    // Some screenshots omit the city/cluster column. In that case only an
    // exact neighborhood cell is safe; a suffix/substring is never enough.
    return undefined;
  }
  // Keep the complete cell as a candidate because slash can be part of an
  // official neighborhood name (for example ST/Gargaú), while still
  // supporting old cells that use slash as a list separator.
  const districts = [normalizeNeighborhoodIdentity(tail), ...tail.split(/[|;,/\n]+/).map(normalizeNeighborhoodIdentity)]
    .filter(Boolean);
  if (!districts.includes(district)) return undefined;

  const relevant = new Set(`${city} ${district} ${preference.regiao ? normalizeNeighborhoodIdentity(regiao || preference.regiao) : ""} ${code.replace("-", " ")}`.split(/\s+/).filter(Boolean));
  const codeBackedByAt = hasExactAt && /^I-\d{1,2}$/.test(code);
  const wordConfidence = row.words.filter((word) => {
    // The thin I is commonly the lowest-confidence glyph in an otherwise
    // clear row. A complete AT on that same row supplies the structural
    // confirmation, so score the city and district instead of vetoing the
    // consensus because of the I/1 glyph alone.
    if (codeBackedByAt && /^(?:(?:I|1|l|\|)\s*[-_:.]?|-{1,2})\s*\d{1,2}$/i.test(word.text)) return false;
    return normalizeNeighborhoodIdentity(word.text).split(" ").some((token) => relevant.has(token));
  }).map((word) => word.confidence);
  const confidence = Math.round(Math.min(row.confidence, ...(wordConfidence.length ? wordConfidence : [row.confidence])));
  return { code, confidence, ...(regiao ? { regiao } : {}), ...extractQuantitiesAfterAt(row), requiresThreeEvidence };
}

function extractQuantitiesAfterAt(row: Row | string) {
  if (typeof row !== "string" && (row.paradas !== undefined || row.pacotes !== undefined)) {
    return { paradas: row.paradas, pacotes: row.pacotes };
  }
  const text = typeof row === "string" ? row : row.text;
  const words = typeof row === "string" ? [] : row.words;
  const fromGeometry = extractQuantitiesFromWords(words);
  if (fromGeometry) return fromGeometry;
  const afterAt = String(text || "").match(/\bAT\s*[A-Z0-9]{6,}\b([\s\S]*)$/i)?.[1] || "";
  // Layout with two numeric cells: AT | stops | packages. Layout with only
  // one numeric cell: AT | packages. A package count must never be used as a
  // stop limit or to rank the preferred neighborhoods.
  const quantities = afterAt.match(/^\s*[|;,]?\s*(\d{1,3})\b\s*[|;,]?\s*(\d{1,3})\b/);
  if (quantities) return { paradas: validQuantity(quantities[1]), pacotes: validQuantity(quantities[2]) };
  const packagesOnly = afterAt.match(/^\s*[|;,]?\s*(\d{1,3})\b/);
  return packagesOnly ? { pacotes: validQuantity(packagesOnly[1]) } : {};
}

function extractQuantitiesFromWords(words: OcrLine["words"]) {
  if (!words?.length) return undefined;
  const sorted = [...words].sort((left, right) => left.left - right.left);
  let atIndex = sorted.findIndex((word) => /^AT[A-Z0-9]{6,}$/i.test(word.text.replace(/[^A-Z0-9]/gi, "")));
  let quantitiesStart = atIndex + 1;
  if (atIndex < 0) {
    atIndex = sorted.findIndex((word, index) => /^AT$/i.test(word.text.trim()) &&
      /^[A-Z0-9]{6,}$/i.test(String(sorted[index + 1]?.text || "").replace(/[^A-Z0-9]/gi, "")));
    quantitiesStart = atIndex + 2;
  }
  if (atIndex < 0) return undefined;
  const quantities: number[] = [];
  for (const word of sorted.slice(quantitiesStart)) {
    const token = word.text.trim().replace(/^[|;,]+|[|;,]+$/g, "");
    if (!token) continue;
    if (!/^\d{1,3}$/.test(token)) break;
    quantities.push(Number(token));
    if (quantities.length === 2) break;
  }
  if (quantities.length >= 2) return { paradas: validQuantity(quantities[0]), pacotes: validQuantity(quantities[1]) };
  return quantities.length === 1 ? { pacotes: validQuantity(quantities[0]) } : {};
}

function validQuantity(value: string | number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 999 ? parsed : undefined;
}

function formatLimits(maxStops: number, maxPackages: number) {
  const limits = [maxStops ? `${maxStops} paradas` : "", maxPackages ? `${maxPackages} pacotes` : ""].filter(Boolean);
  return `o limite geral de ${limits.join(" ou ")}`;
}

function mostFrequentNumber(values: number[]) {
  if (!values.length) return undefined;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

function hasExplicitCityDistrictPair(value: string, configuredCity: string, configuredDistrict: string) {
  const cityAliases = getCityAliases(configuredCity);
  const district = normalizeNeighborhoodIdentity(configuredDistrict);
  const normalizedValue = normalizeNeighborhoodIdentity(value);
  // OCR frequently drops the visual hyphen from the final "Campos - Centro"
  // cell. Requiring the exact city+district pair at the end remains safe and
  // does not turn an earlier unrelated neighborhood into a match.
  if ([...cityAliases].some((city) => normalizedValue.endsWith(`${city} ${district}`))) return true;
  // Headerless screenshots commonly expose a final cell as
  // "Campos - Parque Santa Clara". Only explicit separators are accepted so
  // another free-text column cannot be mistaken for the configured city.
  const parts = String(value || "").split(/\s+(?:-|–|—)\s+|[|;,/\n]+/)
    .map(normalizeNeighborhoodIdentity).filter(Boolean);
  return parts.some((part, index) =>
    [...cityAliases].some((city) => part === city || part.endsWith(` ${city}`)) &&
    parts[index + 1] === district);
}

function getCityAliases(value: string) {
  const city = normalizeNeighborhoodIdentity(value);
  const aliases = new Set([city]);
  if (city === "campos dos goytacazes") aliases.add("campos");
  if (city === "campos") aliases.add("campos dos goytacazes");
  if (city === "sao francisco de itabapoana") aliases.add("sfi");
  if (city === "sfi") aliases.add("sao francisco de itabapoana");
  if (city === "sao joao da barra") aliases.add("sjb");
  if (city === "sjb") aliases.add("sao joao da barra");
  return aliases;
}

function findCityQualifiedDistricts(value: string, configuredCity: string) {
  const aliases = [...getCityAliases(configuredCity)].sort((left, right) => right.length - left.length);
  // Semicolon/pipe/newline separate destinations. Slash is deliberately kept:
  // operational names such as "ST/Gargaú" use it inside the neighborhood.
  return String(value || "").split(/[;|\n]+/).map((part) => normalizeNeighborhoodIdentity(part))
    .flatMap((part) => {
      const alias = aliases.find((candidate) => part.startsWith(`${candidate} `));
      return alias ? [part.slice(alias.length).trim()] : [];
    }).filter(Boolean);
}

function findLeadingCityAlias(value: string, configuredCity: string) {
  return [...getCityAliases(configuredCity)]
    .sort((left, right) => right.length - left.length)
    .find((alias) => value.startsWith(`${alias} `));
}

function isCompatibleCity(value: string, configuredCity: string) {
  const locality = normalizeNeighborhoodIdentity(value);
  const city = normalizeNeighborhoodIdentity(configuredCity);
  if (!locality || !city) return true;
  if (locality === city || locality.startsWith(`${city} `) || locality.endsWith(` ${city}`)) return true;
  // The operational table abbreviates Campos dos Goytacazes as "Campos".
  if (getCityAliases(city).has("campos")) return locality === "campos" || locality.startsWith("campos ");
  return false;
}

function removeLeadingPlaceTokens(text: string, count: number) {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const last = words[count - 1];
  return last ? text.slice(last.index! + last[0].length).replace(/^[\s|;,:-]+/, "") : "";
}

function stripMetadata(text: string) {
  let remaining = text.replace(/^[\s|;,:]+/, "");
  while (/^(?:AT[A-Z0-9]{6,}|\d+(?:[.:/-]\d+)*|AM|PM)\b[\s|;,:]*/i.test(remaining)) {
    remaining = remaining.replace(/^(?:AT[A-Z0-9]{6,}|\d+(?:[.:/-]\d+)*|AM|PM)\b[\s|;,:]*/i, "");
  }
  return remaining.trim();
}

function readRows(reading: RouteOcrResult): Row[] {
  if (!reading.lines?.length) {
    // Text-only output has no confidence or trustworthy geometry. Keep each
    // physical text line separate, but never grant it automatic-send evidence.
    return String(reading.text || "").split(/\r?\n/).filter((line) => line.trim())
      .map((text) => ({ text, words: [], confidence: 0 }));
  }
  const positioned = reading.lines.filter((line) => line.text?.trim());
  const withWords = positioned.flatMap((line) => line.words || []);
  if (!withWords.length) return positioned.map((line) => ({ text: line.text, words: [], confidence: 0 }));

  // Rebuild visual rows from word boxes, including when Tesseract grouped a
  // whole column into one textual line. A word must overlap the row vertically;
  // proximity alone is not sufficient to borrow a cage from an adjacent row.
  const groups: OcrLine["words"][] = [];
  for (const word of [...withWords].sort((left, right) => left.top - right.top || left.left - right.left)) {
    if (!Number.isFinite(word.top) || !Number.isFinite(word.height) || word.height <= 0 || !word.text.trim()) continue;
    const compatible = groups.filter((group) => group.every((existing) => {
      const overlap = Math.min(existing.top + existing.height, word.top + word.height) - Math.max(existing.top, word.top);
      const distance = Math.abs(existing.top + existing.height / 2 - word.top - word.height / 2);
      return overlap >= Math.min(existing.height, word.height) * 0.6 &&
        distance <= Math.min(existing.height, word.height) * 0.4;
    }));
    if (compatible.length === 1) compatible[0].push(word);
    else groups.push([word]);
  }
  const neighborhoodHeaders = withWords.filter((word) => /^(bairro|bairros)$/.test(normalizeNeighborhoodIdentity(word.text)) && word.confidence >= 65);
  const districtHeader = neighborhoodHeaders.length === 1 ? neighborhoodHeaders[0] : undefined;
  const precedingHeader = districtHeader ? withWords.filter((word) =>
    word.left + word.width < districtHeader.left &&
    Math.abs(word.top - districtHeader.top) <= districtHeader.height * 0.4)
    .sort((left, right) => right.left - left.left)[0] : undefined;
  const districtStart = districtHeader && precedingHeader
    ? (precedingHeader.left + precedingHeader.width + districtHeader.left) / 2 : undefined;
  const clusterHeaders = withWords.filter((word) => /^(cluster|regiao)$/.test(normalizeNeighborhoodIdentity(word.text)) && word.confidence >= 65);
  const localityHeaders = clusterHeaders.length ? clusterHeaders : withWords.filter((word) => /^cidade$/.test(normalizeNeighborhoodIdentity(word.text)) && word.confidence >= 65);
  const localityHeader = localityHeaders.length === 1 ? localityHeaders[0] : undefined;
  const beforeLocalityHeader = localityHeader ? withWords.filter((word) =>
    word.left + word.width < localityHeader.left &&
    Math.abs(word.top - localityHeader.top) <= localityHeader.height * 0.4)
    .sort((left, right) => right.left - left.left)[0] : undefined;
  const localityStart = localityHeader && beforeLocalityHeader
    ? (beforeLocalityHeader.left + beforeLocalityHeader.width + localityHeader.left) / 2 : undefined;
  const localityEnd = localityHeader && districtHeader && localityHeader.left < districtHeader.left
    ? (localityHeader.left + localityHeader.width + districtHeader.left) / 2 : undefined;
  const metricColumns = detectMetricColumns(groups);
  return groups.map((words) => {
    const sorted = [...words].sort((left, right) => left.left - right.left);
    const quantities = inferRowQuantities(sorted, metricColumns);
    return { text: sorted.map((word) => word.text).join(" "), words: sorted,
      districtText: districtStart !== undefined && sorted[0].top > districtHeader!.top + districtHeader!.height
        ? sorted.filter((word) => word.left + word.width / 2 >= districtStart).map((word) => word.text).join(" ") : undefined,
      localityText: localityStart !== undefined && sorted[0].top > localityHeader!.top + localityHeader!.height
        ? sorted.filter((word) => {
          const center = word.left + word.width / 2;
          return center >= localityStart && (localityEnd === undefined || center < localityEnd);
        }).map((word) => word.text).join(" ") : undefined,
      trailingCellText: districtStart === undefined ? inferTrailingCellText(sorted) : undefined,
      ...quantities,
      confidence: sorted.reduce((total, word) => total + word.confidence, 0) / sorted.length };
  });
}

function detectMetricColumns(groups: OcrLine["words"][]) {
  const heights = groups.flat().map((word) => word.height).filter((height) => height > 0).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] || 12;
  const tolerance = Math.max(12, typicalHeight * 1.8);
  const clusters: Array<{ center: number; count: number }> = [];
  for (const group of groups) {
    const numericWords = dedupeNumericWords(group, false);
    for (const word of numericWords) {
      const center = word.left + word.width / 2;
      const cluster = clusters.find((item) => Math.abs(item.center - center) <= tolerance);
      if (cluster) {
        cluster.center = ((cluster.center * cluster.count) + center) / (cluster.count + 1);
        cluster.count += 1;
      } else clusters.push({ center, count: 1 });
    }
  }
  // Require a real table pattern across at least three rows. Short/free-text
  // OCR lines can place numbers at similar x positions by coincidence and
  // must continue through the AT-based parser instead.
  const columns = clusters.filter((cluster) => cluster.count >= 3)
    .sort((left, right) => right.count - left.count)
    .slice(0, 2)
    .sort((left, right) => left.center - right.center)
    .map((cluster) => ({ ...cluster, tolerance: tolerance * 1.6 }));
  // Geometry is only needed for the two-column PARADAS/PACOTES layout. A
  // single column remains handled by the textual AT parser as packages.
  return columns.length === 2 ? columns : [];
}

function inferRowQuantities(words: OcrLine["words"], columns: Array<{ center: number; tolerance: number }>) {
  const numericWords = dedupeNumericWords(words, true);
  if (!numericWords.length || !columns.length) return {};
  const values = columns.map((column) => {
    const nearest = numericWords.map((word) => ({
      value: validMetricQuantity(word.text),
      distance: Math.abs(word.left + word.width / 2 - column.center)
    })).filter((item) => item.value !== undefined && item.distance <= column.tolerance)
      .sort((left, right) => left.distance - right.distance)[0];
    return nearest?.value;
  });
  return columns.length >= 2
    ? { paradas: values[0], pacotes: values[1] }
    : { pacotes: values[0] };
}

function dedupeNumericWords(words: OcrLine["words"], allowMisreadFour: boolean) {
  const found: OcrLine["words"] = [];
  for (const word of [...words].sort((left, right) => left.left - right.left)) {
    const token = word.text.trim();
    if (!(allowMisreadFour ? /^[0-9uU]{1,3}$/ : /^\d{1,3}$/).test(token)) continue;
    const center = word.left + word.width / 2;
    if (found.some((existing) => Math.abs(existing.left + existing.width / 2 - center) <= Math.max(4, word.width * 0.35))) continue;
    found.push(word);
  }
  return found;
}

function validMetricQuantity(value: string | number) {
  // In these compressed screenshots the open top of digit 4 is repeatedly
  // recognized as "u". Recover it only after table geometry has proven that
  // the token sits inside PARADAS or PACOTES.
  return validQuantity(String(value).replace(/[uU]/g, "4"));
}

function inferTrailingCellText(words: OcrLine["words"]) {
  if (words.length < 4) return undefined;
  const heights = words.map((word) => word.height).filter((height) => height > 0).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] || 0;
  // Choose the rightmost real column gap. Normal spaces inside a city or
  // multi-word neighborhood are substantially narrower than one text height.
  let cellStart = -1;
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const gap = words[index].left - (previous.left + previous.width);
    if (gap >= typicalHeight * 1.35) cellStart = index;
  }
  if (cellStart < 0) return undefined;
  return words.slice(cellStart).map((word) => word.text).join(" ");
}
