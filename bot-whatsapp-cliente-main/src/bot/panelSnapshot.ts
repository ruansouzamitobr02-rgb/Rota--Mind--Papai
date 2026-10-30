import type { BotSnapshot, OcrRouteSelectionState } from "../shared/types";

/** Photos stay in the bot's stores; transport only authenticated, lazy image references. */
export function compactPanelSnapshot(snapshot: BotSnapshot, clientEmail: string): BotSnapshot {
  const reference = (image: string | undefined, id: string | undefined) => image?.startsWith("data:image/") && id
    ? `/api/analysis-preview?client=${encodeURIComponent(clientEmail)}&id=${encodeURIComponent(id)}` : image;
  const analysis = (item: OcrRouteSelectionState) => ({
    ...item,
    imagePreviewUrl: reference(item.imagePreviewUrl, item.analysisId || item.processedAt)
  });
  return {
    ...snapshot,
    ocrRouteSelection: snapshot.ocrRouteSelection ? analysis(snapshot.ocrRouteSelection) : undefined,
    ocrAnalysisHistory: snapshot.ocrAnalysisHistory?.map(analysis),
    routeDispatches: snapshot.routeDispatches?.map((route) => route.ocr?.imagePreviewUrl ? {
      ...route,
      ocr: { ...route.ocr, imagePreviewUrl: reference(route.ocr.imagePreviewUrl, route.id) }
    } : route)
  };
}
