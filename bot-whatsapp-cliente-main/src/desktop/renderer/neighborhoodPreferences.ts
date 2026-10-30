import { BotConfig, MonitoredRoute } from "../../shared/types";
import { isCentroNeighborhood } from "../../shared/neighborhoodRegion";

function preferenceKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

/** Preserve order and distinguish equal neighborhood names with different region restrictions. */
export function normalizeNeighborhoodPreferences(routes: MonitoredRoute[]): MonitoredRoute[] {
  const seen = new Set<string>();
  return routes
    .map((route) => ({
      cidade: "",
      bairro: String(route?.bairro || "").trim().replace(/\s+/g, " "),
      ...(isCentroNeighborhood(route?.bairro) && typeof route?.regiao === "string" && route.regiao.trim() ? { regiao: route.regiao.trim().replace(/\s+/g, " ") } : {}),
      enabled: route?.enabled !== false,
      ...(route?.conditionMetric === "stops" || route?.conditionMetric === "packages"
        ? { conditionMetric: route.conditionMetric, conditionMax: Math.max(0, Math.min(999, Math.floor(Number(route.conditionMax) || 0))) }
        : {})
    }))
    .filter((route) => {
      if (!route.bairro) return false;
      const key = `${preferenceKey(route.bairro)}::${preferenceKey(route.regiao || "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function getNeighborhoodPreferences(config: Pick<BotConfig, "rotasMonitoradas" | "rotasMonitoradasDetalhadas">): MonitoredRoute[] {
  const detailed = normalizeNeighborhoodPreferences(config.rotasMonitoradasDetalhadas || []);
  return detailed.length ? detailed : normalizeNeighborhoodPreferences((config.rotasMonitoradas || []).map((bairro) => ({ cidade: "", bairro, enabled: true })));
}

export function getEnabledNeighborhoodPreferences(routes: MonitoredRoute[]): MonitoredRoute[] {
  return routes.filter((route) => route.enabled !== false);
}

export function moveNeighborhoodPreference(routes: MonitoredRoute[], fromIndex: number, toIndex: number): MonitoredRoute[] {
  if (fromIndex < 0 || fromIndex >= routes.length || toIndex < 0 || toIndex >= routes.length) return routes;
  const next = [...routes];
  const [route] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, route);
  return next;
}

export function neighborhoodPreferenceLabel(route: MonitoredRoute) {
  const label = route.regiao ? `${route.bairro} · ${route.regiao}` : route.bairro;
  if (!route.conditionMetric || !(Number(route.conditionMax) > 0)) return label;
  return `${label} — até ${route.conditionMax} ${route.conditionMetric === "packages" ? "pacotes" : "paradas"}`;
}
