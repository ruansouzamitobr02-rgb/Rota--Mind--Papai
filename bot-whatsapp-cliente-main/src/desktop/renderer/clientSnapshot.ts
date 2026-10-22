import type { BotSnapshot } from "../../shared/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Never replace the last usable screen with a partial response during reconnect.
export function parseClientSnapshot(value: unknown): BotSnapshot {
  if (!isRecord(value) || !isRecord(value.config)
    || typeof value.config.nomeEnvio !== "string"
    || !Array.isArray(value.config.codigosMensagensAlvo)
    || !Array.isArray(value.config.codigosMensagensTeste)
    || (value.performanceMetrics !== undefined && !isRecord(value.performanceMetrics))
    || (value.testStatus !== undefined && !isRecord(value.testStatus))
    || !["disconnected", "connecting", "connected", "waiting_qr", "reconnecting", "error"].includes(String(value.status))
    || ![value.groups, value.logs, value.readinessChecks].every((items) => Array.isArray(items) && items.every(isRecord))
    || (value.ocrRouteSelection !== undefined && (!isRecord(value.ocrRouteSelection) || !Array.isArray(value.ocrRouteSelection.options)))) {
    throw new Error("O painel recebeu uma atualização incompleta. Tentando reconectar...");
  }
  return value as unknown as BotSnapshot;
}
