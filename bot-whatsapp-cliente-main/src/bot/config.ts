import { readJsonFile, writeJsonAtomic } from "../storageJson";
import fs from "fs";
import path from "path";
import { BotConfig } from "../shared/types";

export const DEFAULT_CONFIG: BotConfig = {
  grupoAlvoJid: "",
  grupoAlvoNome: "",
  grupoTesteJid: "",
  grupoTesteNome: "",
  nomeEnvio: "",
  targetDispatchMode: "manual",
  nuclearMode: false,
  codigosMensagensAlvo: [],
  rotasMonitoradas: [],
  rotasMonitoradasDetalhadas: [],
  routePresets: [],
  codigosMensagensTeste: [],
  testMessageCount: 15,
  testMessageIntervalMs: 0,
  fastMode: true,
  minSendDelayMs: 0,
  alwaysWarmMode: true,
  keepAliveIntervalMs: 300000,
  ocrManualRouteSelection: false,
  ocrSelectionMode: "neighborhoods",
  ocrDesiredCages: [],
  ocrCageMessageLimit: 3,
  ocrMaxStops: 0,
  ocrMaxPackages: 0,
  ocrRouteChoiceMode: "quantity",
  ocrRouteChoiceMetric: "stops"
};

export class ConfigStore {
  private cached?: BotConfig;

  constructor(private readonly configPath = path.resolve(process.cwd(), "config.json")) {}

  get path() {
    return this.configPath;
  }

  load(): BotConfig {
    if (this.cached) return this.cached;
    this.ensureConfigFile();

    this.cached = this.normalize(readJsonFile<Partial<BotConfig>>(this.configPath, () => ({ ...DEFAULT_CONFIG }),
      (value) => Boolean(value && typeof value === "object" && !Array.isArray(value))));
    return this.cached;
  }

  save(config: Partial<BotConfig>): BotConfig {
    const nextConfig = this.normalize({
      ...this.loadWithoutCreating(),
      ...config
    });

    writeJsonAtomic(this.configPath, nextConfig);
    this.cached = nextConfig;
    return this.cached;
  }

  saveGroup(group: string): BotConfig {
    const value = group.trim();
    const looksLikeJid = value.includes("@g.us");

    return this.save({
      grupoAlvoJid: looksLikeJid ? value : "",
      grupoAlvoNome: looksLikeJid ? "Grupo salvo por ID" : value
    });
  }

  saveGroupById(groupId: string, groupName: string): BotConfig {
    return this.save({
      grupoAlvoJid: groupId.trim(),
      grupoAlvoNome: groupName.trim() || "Grupo salvo"
    });
  }

  saveTestGroup(group: string): BotConfig {
    const value = group.trim();
    const looksLikeJid = value.includes("@g.us");

    return this.save({
      grupoTesteJid: looksLikeJid ? value : "",
      grupoTesteNome: looksLikeJid ? "Grupo teste por ID" : value
    });
  }

  saveTestGroupById(groupId: string, groupName: string): BotConfig {
    return this.save({
      grupoTesteJid: groupId.trim(),
      grupoTesteNome: groupName.trim() || "Grupo teste"
    });
  }

  private ensureConfigFile() {
    if (!fs.existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
    }
  }

  private loadWithoutCreating(): BotConfig {
    if (this.cached) return this.cached;
    if (!fs.existsSync(this.configPath)) {
      return { ...DEFAULT_CONFIG };
    }

    return this.normalize(readJsonFile<Partial<BotConfig>>(this.configPath, () => ({ ...DEFAULT_CONFIG }),
      (value) => Boolean(value && typeof value === "object" && !Array.isArray(value))));
  }

  private normalize(input: Partial<BotConfig>): BotConfig {
    const manualSelection = typeof input.ocrManualRouteSelection === "boolean"
      ? input.ocrManualRouteSelection
      : input.ocrSelectionMode === "manual";
    const wantedCages = Array.isArray(input.ocrDesiredCages)
      ? input.ocrDesiredCages.filter((item): item is string => typeof item === "string" && item.trim().length > 0).length
      : 0;
    const legacyCageMigration = input.ocrSelectionMode === "cages" && wantedCages > 200;
    const selectionMode = legacyCageMigration
      ? "neighborhoods"
      : input.ocrSelectionMode === "best" || input.ocrSelectionMode === "manual"
        || input.ocrSelectionMode === "cages" || input.ocrSelectionMode === "neighborhoods"
        ? input.ocrSelectionMode
        : manualSelection ? "manual" : "neighborhoods";

    return {
      grupoAlvoJid: typeof input.grupoAlvoJid === "string" ? input.grupoAlvoJid : "",
      grupoAlvoNome: typeof input.grupoAlvoNome === "string" ? input.grupoAlvoNome : "",
      grupoTesteJid: typeof input.grupoTesteJid === "string" ? input.grupoTesteJid : "",
      grupoTesteNome: typeof input.grupoTesteNome === "string" ? input.grupoTesteNome : "",
      nomeEnvio: typeof input.nomeEnvio === "string" ? input.nomeEnvio.trim() : DEFAULT_CONFIG.nomeEnvio,
      targetDispatchMode: input.targetDispatchMode === "ocr" ? "ocr" : DEFAULT_CONFIG.targetDispatchMode,
      nuclearMode: typeof input.nuclearMode === "boolean" ? input.nuclearMode : DEFAULT_CONFIG.nuclearMode,
      testMessageCount: this.clampNumber(input.testMessageCount, 1, 200, DEFAULT_CONFIG.testMessageCount),
      testMessageIntervalMs: this.clampNumber(input.testMessageIntervalMs, 0, 10000, DEFAULT_CONFIG.testMessageIntervalMs),
      fastMode: typeof input.fastMode === "boolean" ? input.fastMode : DEFAULT_CONFIG.fastMode,
      minSendDelayMs: this.clampNumber(input.minSendDelayMs, 0, 5000, DEFAULT_CONFIG.minSendDelayMs),
      alwaysWarmMode: typeof input.alwaysWarmMode === "boolean" ? input.alwaysWarmMode : DEFAULT_CONFIG.alwaysWarmMode,
      keepAliveIntervalMs: this.clampNumber(input.keepAliveIntervalMs, 60000, 600000, DEFAULT_CONFIG.keepAliveIntervalMs),
      // Preserve legacy OCR modes when they were explicitly configured, while
      // keeping the neighborhood-first behavior as the safe default for new users.
      ocrManualRouteSelection: manualSelection,
      ocrSelectionMode: selectionMode,
      ocrDesiredCages: Array.isArray(input.ocrDesiredCages)
        ? Array.from(new Set(input.ocrDesiredCages
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().toUpperCase())
            .filter(Boolean)))
        : [],
      ocrCageMessageLimit: this.clampNumber(Number(input.ocrCageMessageLimit) > 0
        ? input.ocrCageMessageLimit : DEFAULT_CONFIG.ocrCageMessageLimit, 1, 3, DEFAULT_CONFIG.ocrCageMessageLimit),
      ocrMaxStops: this.clampNumber(input.ocrMaxStops, 0, 999, DEFAULT_CONFIG.ocrMaxStops),
      ocrMaxPackages: this.clampNumber(input.ocrMaxPackages, 0, 999, DEFAULT_CONFIG.ocrMaxPackages),
      ocrRouteChoiceMode: input.ocrRouteChoiceMode === "preference" ? "preference" : "quantity",
      ocrRouteChoiceMetric: input.ocrRouteChoiceMetric === "packages" ? "packages" : "stops",
      // support legacy `codigosMensagens` if present
      codigosMensagensAlvo: Array.isArray(input.codigosMensagensAlvo)
        ? input.codigosMensagensAlvo.filter((item) => typeof item === "string" && item.trim())
        : Array.isArray((input as any).codigosMensagens)
        ? (input as any).codigosMensagens.filter((item: any) => typeof item === "string" && item.trim())
        : [],
      rotasMonitoradas: Array.isArray(input.rotasMonitoradas)
        ? input.rotasMonitoradas.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : [],
      rotasMonitoradasDetalhadas: Array.isArray(input.rotasMonitoradasDetalhadas)
        ? input.rotasMonitoradasDetalhadas
            .map((item: any) => ({
              cidade: typeof item?.cidade === "string" ? item.cidade.trim() : "",
              bairro: typeof item?.bairro === "string" ? item.bairro.trim() : "",
              ...(typeof item?.regiao === "string" && item.regiao.trim() ? { regiao: item.regiao.trim() } : {}),
              enabled: item?.enabled !== false,
              ...(item?.conditionMetric === "stops" || item?.conditionMetric === "packages" ? {
                conditionMetric: item.conditionMetric,
                conditionMax: this.clampNumber(item.conditionMax, 0, 999, 0)
              } : {})
            }))
            .filter((item) => item.bairro)
        : [],
      routePresets: Array.isArray(input.routePresets)
        ? input.routePresets
            .map((preset: any) => ({
              id: typeof preset?.id === "string" ? preset.id.trim() : "",
              name: typeof preset?.name === "string" ? preset.name.trim() : "",
              routes: Array.isArray(preset?.routes)
                ? preset.routes.map((item: any) => ({
                    cidade: "",
                    bairro: typeof item?.bairro === "string" ? item.bairro.trim() : "",
                    ...(typeof item?.regiao === "string" && item.regiao.trim() ? { regiao: item.regiao.trim() } : {}),
                    enabled: item?.enabled !== false,
                    ...(item?.conditionMetric === "stops" || item?.conditionMetric === "packages" ? {
                      conditionMetric: item.conditionMetric,
                      conditionMax: this.clampNumber(item.conditionMax, 0, 999, 0)
                    } : {})
                  })).filter((item: any) => item.bairro)
                : [],
              createdAt: typeof preset?.createdAt === "string" ? preset.createdAt : new Date().toISOString(),
              updatedAt: typeof preset?.updatedAt === "string" ? preset.updatedAt : new Date().toISOString()
            }))
            .filter((preset: any) => preset.id && preset.name && preset.routes.length)
            .slice(0, 50)
        : [],
      codigosMensagensTeste: Array.isArray(input.codigosMensagensTeste)
        ? input.codigosMensagensTeste.filter((item) => typeof item === "string" && item.trim())
        : []
    };
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(numberValue)));
  }

}
