import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { BotConfig, BotGroup, MonitoredRoute } from "../../../shared/types";
import { uiText } from "../uiText";
import { getEnabledNeighborhoodPreferences, getNeighborhoodPreferences, moveNeighborhoodPreference as moveRoute, neighborhoodPreferenceLabel, normalizeNeighborhoodPreferences as normalizeMonitoredRoutes } from "../neighborhoodPreferences";

type Props = {
  kind: "target" | "test";
  targetMode?: "manual" | "ocr";
  config: BotConfig;
  groups: BotGroup[];
  detectedRegions?: string[];
  busy: boolean;
  onRefresh: () => void;
  onSave: (
    group: string,
    groupId: string | undefined,
    groupName: string | undefined,
    senderName: string,
    codes: string[],
    messageCount?: number,
    intervalMs?: number,
    startAfterSave?: boolean,
    monitoredRoutes?: MonitoredRoute[],
    targetDispatchMode?: "manual" | "ocr",
    ocrCageMessageLimit?: number,
    ocrMaxStops?: number,
    ocrMaxPackages?: number,
    ocrRouteChoiceMode?: BotConfig["ocrRouteChoiceMode"],
    ocrRouteChoiceMetric?: BotConfig["ocrRouteChoiceMetric"]
  ) => void;
  onSaveManual?: (
    group: string,
    groupId: string | undefined,
    groupName: string | undefined,
    senderName: string,
    codes: string[]
  ) => void;
  onWarmup?: () => void;
};

const labels = {
  target: {
    title: "Grupo alvo",
    action: "Salvar alvo",
    placeholder: "Pesquisar grupo alvo",
    empty: "Nenhum grupo alvo"
  },
  test: {
    title: "Teste de abrir e fechar",
    action: "Salvar teste",
    placeholder: "Pesquisar grupo de teste",
    empty: "Nenhum teste salvo"
  }
};

function formatMessageCode(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^([a-zA-Z])\s*-?\s*(\d+)$/);
  if (!match) return trimmed.toUpperCase();
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function parseCodes(value: string) {
  return value
    .split(/\r?\n|,/)
    .map(formatMessageCode)
    .filter(Boolean);
}

function createEmptyRoute(): MonitoredRoute {
  return { cidade: "", bairro: "", enabled: true };
}

export function GroupMessageCard({ kind, targetMode = "manual", config, groups, detectedRegions = [], busy, onRefresh, onSave, onSaveManual, onWarmup }: Props) {
  const [group, setGroup] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [senderName, setSenderName] = useState("");
  const [codes, setCodes] = useState("");
  const [monitoredRoutes, setMonitoredRoutes] = useState<MonitoredRoute[]>([createEmptyRoute()]);
  const [ocrMessageLimit, setOcrMessageLimit] = useState(3);
  const [ocrMaxStops, setOcrMaxStops] = useState(0);
  const [ocrMaxPackages, setOcrMaxPackages] = useState(0);
  const [ocrRouteChoiceMode, setOcrRouteChoiceMode] = useState<BotConfig["ocrRouteChoiceMode"]>("quantity");
  const [ocrRouteChoiceMetric, setOcrRouteChoiceMetric] = useState<BotConfig["ocrRouteChoiceMetric"]>("stops");
  const [manualCodes, setManualCodes] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [messageCount, setMessageCount] = useState(15);
  const [intervalMs, setIntervalMs] = useState(0);
  const requestedGroupsRef = useRef(false);

  const isTarget = kind === "target";
  const isImageTarget = isTarget && targetMode === "ocr";
  const label = labels[kind];
  const savedGroupName = isTarget
    ? config.grupoAlvoNome || ""
    : config.grupoTesteNome || "";
  const savedCodes = useMemo(
    () => (isImageTarget ? config.rotasMonitoradasDetalhadas?.length ? config.rotasMonitoradasDetalhadas.map((item) => item.bairro) : config.rotasMonitoradas || [] : isTarget ? config.codigosMensagensAlvo : config.codigosMensagensTeste) || [],
    [config.codigosMensagensAlvo, config.codigosMensagensTeste, config.rotasMonitoradas, config.rotasMonitoradasDetalhadas, isImageTarget, isTarget]
  );
  const savedCodesKey = savedCodes.join("\n");
  const savedPreferencesKey = JSON.stringify(getNeighborhoodPreferences(config));
  const regionChoices = useMemo(() => {
    const choices = new Map<string, string>();
    for (const value of [...(config.rotasMonitoradasDetalhadas || []).map((route) => route.regiao || ""), ...detectedRegions]) {
      const region = value.trim().replace(/\s+/g, " ");
      const key = region.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (key && !choices.has(key)) choices.set(key, region);
    }
    return [...choices.values()].sort((left, right) => left.localeCompare(right, "pt-BR"));
  }, [savedPreferencesKey, detectedRegions]);
  const nextPreferences = normalizeMonitoredRoutes(monitoredRoutes);
  const activePreferences = getEnabledNeighborhoodPreferences(nextPreferences);
  const hasIncompletePreference = monitoredRoutes.some((route) => !route.bairro.trim());
  const hasIncompleteCondition = monitoredRoutes.some((route) => route.conditionMetric && !(Number(route.conditionMax) > 0));
  const hasIncompleteRegion = monitoredRoutes.some((route) => route.regiao !== undefined && !route.regiao.trim());
  const hasMessageSettings = isImageTarget ? nextPreferences.length > 0 && !hasIncompletePreference && !hasIncompleteCondition && !hasIncompleteRegion : parseCodes(codes).length > 0;

  useEffect(() => {
    setGroup(isTarget ? config.grupoAlvoNome || "" : config.grupoTesteNome || "");
    setSelectedGroupId(isTarget ? config.grupoAlvoJid || "" : config.grupoTesteJid || "");
    setSenderName(config.nomeEnvio);
    setCodes(savedCodesKey);
    const savedPreferences = getNeighborhoodPreferences(config);
    setMonitoredRoutes(savedPreferences.length ? savedPreferences.map((route) => ({ ...route })) : [createEmptyRoute()]);
    setOcrMessageLimit(Math.max(1, Math.min(3, Number(config.ocrCageMessageLimit) || 3)));
    setOcrMaxStops(Math.max(0, Math.min(999, Number(config.ocrMaxStops) || 0)));
    setOcrMaxPackages(Math.max(0, Math.min(999, Number(config.ocrMaxPackages) || 0)));
    setOcrRouteChoiceMode(config.ocrRouteChoiceMode || "quantity");
    setOcrRouteChoiceMetric(config.ocrRouteChoiceMetric || "stops");
    setManualCodes((config.codigosMensagensAlvo || []).join("\n"));
    setMessageCount(config.testMessageCount || 15);
    setIntervalMs(config.testMessageIntervalMs || 0);
  }, [
    config.grupoAlvoJid,
    config.grupoAlvoNome,
    config.grupoTesteJid,
    config.grupoTesteNome,
    config.nomeEnvio,
    config.testMessageCount,
    config.testMessageIntervalMs,
    config.ocrCageMessageLimit,
    config.ocrMaxStops,
    config.ocrMaxPackages,
    config.ocrRouteChoiceMode,
    config.ocrRouteChoiceMetric,
    isTarget,
    savedCodesKey,
    savedPreferencesKey
  ]);

  useEffect(() => {
    if (requestedGroupsRef.current || groups.length || busy) return;
    requestedGroupsRef.current = true;
    onRefresh();
  }, [busy, groups.length, onRefresh]);

  function submit(event: Pick<FormEvent, "preventDefault">, startAfterSave = false) {
    event.preventDefault();
    const selectedGroup = groups.find((item) => item.id === selectedGroupId);
    const foundByName = groups.find((item) => item.name.toLowerCase() === group.trim().toLowerCase());
    const chosenGroup = selectedGroup || foundByName;
    const value = chosenGroup ? chosenGroup.name : group.trim();
    if (busy) return;
    const nextRoutes = isImageTarget ? normalizeMonitoredRoutes(monitoredRoutes) : [];
    const nextCodes = isImageTarget ? nextRoutes.map((item) => item.bairro) : parseCodes(codes);

    if (!value || !senderName.trim() || !nextCodes.length || (isImageTarget && (hasIncompletePreference || hasIncompleteCondition || hasIncompleteRegion || (startAfterSave && !getEnabledNeighborhoodPreferences(nextRoutes).length)))) return;
    setCodes(nextCodes.join("\n"));
    onSave(value, chosenGroup?.id, chosenGroup?.name, senderName.trim(), nextCodes, messageCount, intervalMs, startAfterSave, nextRoutes, isImageTarget ? "ocr" : "manual", ocrMessageLimit, ocrMaxStops, ocrMaxPackages, ocrRouteChoiceMode, ocrRouteChoiceMetric);
  }

  function submitManual(event: Pick<FormEvent, "preventDefault">) {
    event.preventDefault();
    const selectedGroup = groups.find((item) => item.id === selectedGroupId);
    const foundByName = groups.find((item) => item.name.toLowerCase() === group.trim().toLowerCase());
    const chosenGroup = selectedGroup || foundByName;
    const value = chosenGroup ? chosenGroup.name : group.trim();
    const nextCodes = parseCodes(manualCodes);
    if (!value || !senderName.trim() || !nextCodes.length || !onSaveManual) return;
    setManualCodes(nextCodes.join("\n"));
    onSaveManual(value, chosenGroup?.id, chosenGroup?.name, senderName.trim(), nextCodes);
  }

  const previewMessages = isImageTarget
    ? activePreferences.map((route, index) => `Preferência ativa ${index + 1}: ${neighborhoodPreferenceLabel(route)}`)
    : parseCodes(codes).map((code) => `${senderName.trim() || config.nomeEnvio} ${code.toUpperCase()}`.trim());
  const query = group.trim().toLowerCase();
  const filteredGroups = groups
    .filter((item) => !query || item.name.toLowerCase().includes(query))
    .slice(0, 12);

  return (
    <article className={`panel group-message-card ${isTarget ? "group-message-target" : "group-message-test"}`}>
      <div className="compact-heading">
        <p className="panel-label">{label.title}</p>
        <strong>{savedGroupName || label.empty}</strong>
      </div>

      <form className="group-form" onSubmit={(event) => submit(event)}>
        <div className="form-heading-row">
          <label htmlFor={`${kind}-group-search`}>Grupo</label>
          <button className="link-button" disabled={busy} type="button" onClick={onRefresh}>
            Atualizar
          </button>
        </div>
        <input
          id={`${kind}-group-search`}
          value={group}
          onChange={(event) => {
            setGroup(event.target.value);
            setSelectedGroupId("");
          }}
          placeholder={label.placeholder}
        />
        {filteredGroups.length ? (
          <div className="group-search-list">
            {filteredGroups.map((item) => (
              <button
                key={item.id}
                className={selectedGroupId === item.id ? "selected" : ""}
                type="button"
                onClick={() => {
                  setGroup(item.name);
                  setSelectedGroupId(item.id);
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="group-search-list group-search-empty">
            <span>{groups.length ? "Nenhum grupo encontrado com essa pesquisa." : "Conecte o WhatsApp e toque em Atualizar para carregar os grupos."}</span>
          </div>
        )}

        <label htmlFor={`${kind}-sender-name`}>Nome fixo na mensagem</label>
        <input
          id={`${kind}-sender-name`}
          value={senderName}
          onChange={(event) => setSenderName(event.target.value)}
          placeholder="Digite seu nome"
        />

        {isImageTarget ? (
          <div className="ocr-primary-copy">
            <strong>Bairros monitorados</strong>
            <span>O bot encontra os bairros da lista e aplica o critério de escolha configurado abaixo.</span>
          </div>
        ) : null}

        {isImageTarget ? (
          <section className="ocr-route-fields">
            <div className="ocr-settings-section">
              <div className="ocr-settings-title">
                <strong>1. Regras de envio</strong>
                <span>Escolha quantas rotas podem ser enviadas por imagem.</span>
              </div>
            <div className="settings-grid compact-settings">
              <label>
                Máximo de mensagens por imagem
                <select
                  aria-label="Máximo de mensagens por imagem"
                  value={ocrMessageLimit}
                  disabled={busy}
                  onChange={(event) => setOcrMessageLimit(Number(event.target.value))}
                >
                  <option value={1}>1 mensagem</option>
                  <option value={2}>2 mensagens</option>
                  <option value={3}>3 mensagens</option>
                </select>
              </label>
              <small>Se a imagem tiver menos bairros confirmados, o bot envia somente os encontrados.</small>
            </div>
            <div className="settings-grid compact-settings">
              <label>
                Cérebro do bot
                <select aria-label="Critério de escolha das rotas" value={ocrRouteChoiceMode} disabled={busy} onChange={(event) => setOcrRouteChoiceMode(event.target.value as BotConfig["ocrRouteChoiceMode"])}>
                  <option value="preference">Ordem de preferência</option>
                  <option value="quantity">Menor quantidade</option>
                </select>
              </label>
              <small>{ocrRouteChoiceMode === "preference" ? "O primeiro bairro válido do seu ranking será enviado antes dos demais." : "O bot compara as rotas válidas e envia primeiro a que tiver o menor número."}</small>
            </div>
            {ocrRouteChoiceMode === "quantity" ? (
              <div className="settings-grid compact-settings">
                <label>
                  Quantidade usada na escolha
                  <select aria-label="Quantidade usada na escolha" value={ocrRouteChoiceMetric} disabled={busy} onChange={(event) => setOcrRouteChoiceMetric(event.target.value as BotConfig["ocrRouteChoiceMetric"])}>
                    <option value="stops">Menos paradas</option>
                    <option value="packages">Menos pacotes</option>
                  </select>
                </label>
                <small>Se essa quantidade não estiver legível, a ordem de preferência decide.</small>
              </div>
            ) : null}
            <div className="settings-grid compact-settings">
              <label>
                Limite geral de paradas
                <input aria-label="Limite geral de paradas" type="number" min={0} max={999} value={ocrMaxStops || ""} disabled={busy} placeholder="Sem limite" onChange={(event) => setOcrMaxStops(event.target.value ? Number(event.target.value) : 0)} />
              </label>
              <small>Vale para todos os bairros. Acima desse número a rota não é enviada; se as paradas não forem legíveis, a preferência cadastrada decide.</small>
            </div>
            <div className="settings-grid compact-settings">
              <label>
                Limite geral de pacotes
                <input aria-label="Limite geral de pacotes" type="number" min={0} max={999} value={ocrMaxPackages || ""} disabled={busy} placeholder="Sem limite" onChange={(event) => setOcrMaxPackages(event.target.value ? Number(event.target.value) : 0)} />
              </label>
              <small>Acima desse número a rota é descartada e o bot tenta a próxima opção válida do ranking de bairros.</small>
            </div>
            <section className={`ocr-quantity-limit-notice ${ocrMaxStops || ocrMaxPackages ? "has-limits" : ""}`} aria-live="polite">
              <strong>{ocrMaxStops || ocrMaxPackages ? "Estes limites bloqueiam o envio" : "Sem limites gerais de quantidade"}</strong>
              <span>{ocrMaxStops || ocrMaxPackages
                ? `Só passam rotas com ${[ocrMaxStops ? `até ${ocrMaxStops} paradas` : "", ocrMaxPackages ? `até ${ocrMaxPackages} pacotes` : ""].filter(Boolean).join(" e ")}. Isso vale mesmo quando o bairro e a região estão corretos.`
                : "O bot segue os bairros, regiões e condições individuais. A quantidade serve para ordenar as rotas, sem um teto geral."}</span>
              {ocrMaxStops || ocrMaxPackages ? (
                <button className="button secondary" disabled={busy} type="button" onClick={() => {
                  setOcrMaxStops(0);
                  setOcrMaxPackages(0);
                }}>Remover limites gerais</button>
              ) : null}
            </section>
            </div>
            <div className="ocr-settings-section ocr-preferences-section">
            <div className="ocr-settings-title">
              <strong>2. Bairros preferidos</strong>
              <span>Pause um bairro sem apagá-lo. Se houver empate nas paradas, esta ordem decide primeiro.</span>
            </div>
            <div className="ocr-preference-summary">
              <span><b>{activePreferences.length}</b> ativa(s)</span>
              <span><b>{nextPreferences.length - activePreferences.length}</b> pausada(s)</span>
            </div>
            <div className="ocr-route-heading">
              <span>Preferência</span>
              <span>Bairro</span>
            </div>
            {monitoredRoutes.map((route, index) => (
              <div className={`ocr-route-row ${route.enabled === false ? "is-paused" : ""}`} key={`ocr-route-${index}`}>
                <span className="ocr-route-index">{index + 1}ª opção</span>
                <div className="ocr-neighborhood-inputs">
                <input
                  aria-label={`Bairro da preferência ${index + 1}`}
                  maxLength={200}
                  disabled={busy}
                  value={route.bairro}
                  onChange={(event) => {
                    const nextRoutes = [...monitoredRoutes];
                    nextRoutes[index] = { ...route, bairro: event.target.value };
                    setMonitoredRoutes(nextRoutes);
                  }}
                  placeholder="Bairro: Parque Penha"
                />
                <div className="preference-region">
                  <label>
                    <span>Região deste bairro</span>
                    <select
                      aria-label={`Escolher região da preferência ${index + 1}`}
                      disabled={busy}
                      value={route.regiao === undefined ? "" : regionChoices.includes(route.regiao) ? route.regiao : "__custom__"}
                      onChange={(event) => {
                        const nextRoutes = [...monitoredRoutes];
                        if (!event.target.value) {
                          const { regiao: _regiao, ...withoutRegion } = route;
                          nextRoutes[index] = withoutRegion;
                        } else nextRoutes[index] = { ...route, regiao: event.target.value === "__custom__" ? "" : event.target.value };
                        setMonitoredRoutes(nextRoutes);
                      }}
                    >
                      <option value="">Qualquer região (sem restrição)</option>
                      {regionChoices.map((region) => <option key={region} value={region}>{region}</option>)}
                      <option value="__custom__">Digitar outra região...</option>
                    </select>
                  </label>
                  {route.regiao !== undefined && !regionChoices.includes(route.regiao) ? (
                    <input
                      aria-label={`Região da preferência ${index + 1}`}
                      maxLength={200}
                      disabled={busy}
                      value={route.regiao}
                      placeholder="Ex.: Campos - Tamandaré"
                      onChange={(event) => {
                        const nextRoutes = [...monitoredRoutes];
                        nextRoutes[index] = { ...route, regiao: event.target.value };
                        setMonitoredRoutes(nextRoutes);
                      }}
                    />
                  ) : null}
                  <small>{route.regiao ? `Só aceita ${route.bairro || "este bairro"} na região ${route.regiao}.`
                    : "Escolha uma região lida nas imagens para separar bairros com o mesmo nome."}</small>
                </div>
                {route.conditionMetric ? (
                  <div className="preference-condition">
                    <select
                      aria-label={`Tipo da condição da preferência ${index + 1}`}
                      disabled={busy}
                      value={route.conditionMetric}
                      onChange={(event) => {
                        const nextRoutes = [...monitoredRoutes];
                        nextRoutes[index] = { ...route, conditionMetric: event.target.value as "stops" | "packages" };
                        setMonitoredRoutes(nextRoutes);
                      }}
                    >
                      <option value="stops">Paradas</option>
                      <option value="packages">Pacotes</option>
                    </select>
                    <input
                      aria-label={`Máximo da condição da preferência ${index + 1}`}
                      type="number" min={1} max={999} disabled={busy}
                      value={route.conditionMax || ""} placeholder="Máximo"
                      onChange={(event) => {
                        const nextRoutes = [...monitoredRoutes];
                        nextRoutes[index] = { ...route, conditionMax: event.target.value ? Number(event.target.value) : 0 };
                        setMonitoredRoutes(nextRoutes);
                      }}
                    />
                    <button className="link-button danger-link" disabled={busy} type="button" onClick={() => {
                      const { conditionMetric: _metric, conditionMax: _max, ...withoutCondition } = route;
                      const nextRoutes = [...monitoredRoutes];
                      nextRoutes[index] = withoutCondition;
                      setMonitoredRoutes(nextRoutes);
                    }}>Remover condição</button>
                  </div>
                ) : (
                  <button className="link-button add-condition-button" disabled={busy} type="button" onClick={() => {
                    const nextRoutes = [...monitoredRoutes];
                    nextRoutes[index] = { ...route, conditionMetric: "stops", conditionMax: 0 };
                    setMonitoredRoutes(nextRoutes);
                  }}>+ Adicionar condição de paradas ou pacotes</button>
                )}
                </div>
                <button
                  aria-checked={route.enabled !== false}
                  aria-label={`${route.enabled === false ? "Ativar" : "Pausar"} preferência ${index + 1}`}
                  className={`preference-toggle ${route.enabled === false ? "is-off" : "is-on"}`}
                  disabled={busy}
                  role="switch"
                  title={route.enabled === false ? "Ativar este bairro" : "Pausar este bairro"}
                  type="button"
                  onClick={() => {
                    const nextRoutes = [...monitoredRoutes];
                    nextRoutes[index] = { ...route, enabled: route.enabled === false };
                    setMonitoredRoutes(nextRoutes);
                  }}
                >
                  <span aria-hidden="true" />
                  {route.enabled === false ? "Pausada" : "Ativa"}
                </button>
                {monitoredRoutes.length > 1 ? (
                  <div className="ocr-route-rank-actions">
                    <button className="icon-button" disabled={busy || index === 0} title="Aumentar preferência" type="button" onClick={() => setMonitoredRoutes(moveRoute(monitoredRoutes, index, index - 1))}>
                      <ArrowUp size={16} />
                    </button>
                    <button className="icon-button" disabled={busy || index === monitoredRoutes.length - 1} title="Diminuir preferência" type="button" onClick={() => setMonitoredRoutes(moveRoute(monitoredRoutes, index, index + 1))}>
                      <ArrowDown size={16} />
                    </button>
                    <button className="icon-button" title="Remover bairro" disabled={busy} type="button" onClick={() => setMonitoredRoutes(monitoredRoutes.filter((_, itemIndex) => itemIndex !== index))}>
                      ×
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="ocr-route-actions">
              <button className="button secondary" disabled={busy} type="button" onClick={() => setMonitoredRoutes([...monitoredRoutes, createEmptyRoute()])}>
                Adicionar outro bairro
              </button>
              <small>{activePreferences.length} de {nextPreferences.length} bairro(s) participam da análise. Use as setas para ordenar as preferências ativas.</small>
              {hasIncompletePreference ? <small role="alert">Preencha o bairro antes de salvar.</small> : null}
              {hasIncompleteRegion ? <small role="alert">Preencha a região ou remova a restrição antes de salvar.</small> : null}
              {hasIncompleteCondition ? <small role="alert">Informe um máximo maior que zero para cada condição adicionada.</small> : null}
              {!activePreferences.length && nextPreferences.length ? <small role="alert">Todas as preferências estão pausadas. Você pode salvar, mas precisa ativar ao menos uma para iniciar o bot imagem.</small> : null}
            </div>
            </div>
          </section>
        ) : (
          <>
            <label htmlFor={`${kind}-codes`}>Códigos</label>
            <textarea
              id={`${kind}-codes`}
              value={codes}
              onChange={(event) => setCodes(event.target.value)}
              onBlur={() => setCodes(parseCodes(codes).join("\n"))}
              placeholder="Ex: P-12"
              rows={3}
            />
          </>
        )}

        {!isTarget ? (
          <div className="test-settings-grid">
            <label htmlFor={`${kind}-count`}>
              Quantidade
              <input
                id={`${kind}-count`}
                min={1}
                max={200}
                type="number"
                value={messageCount}
                onChange={(event) => setMessageCount(Number(event.target.value || 1))}
              />
            </label>
            <label htmlFor={`${kind}-interval`}>
              Intervalo ms
              <input
                id={`${kind}-interval`}
                min={0}
                max={10000}
                step={50}
                type="number"
                value={intervalMs}
                onChange={(event) => setIntervalMs(Number(event.target.value || 0))}
              />
            </label>
          </div>
        ) : null}

        <button className="button primary" disabled={busy || !group.trim() || !senderName.trim() || !hasMessageSettings} type="submit">
          {label.action}
        </button>
        {isTarget ? (
          <button className="button skull-button" disabled={busy || !group.trim() || !senderName.trim() || !hasMessageSettings || (isImageTarget && !activePreferences.length)} type="button" onClick={(event) => submit(event, true)}>
            <span aria-hidden="true">☠</span>
            Salvar e iniciar
          </button>
        ) : null}
        {!isTarget && onWarmup ? (
          <button className="button secondary" disabled={busy || !savedGroupName} type="button" onClick={onWarmup}>
            Testar envio
          </button>
        ) : null}

        <div className="message-preview compact-preview">
          <strong>{previewMessages.length} {isImageTarget ? "preferência(s) de bairro" : "mensagem(ns)"}</strong>
          {previewMessages.slice(0, 3).map((message, index) => (
            <span key={`${message}-${index}`}>{uiText(message)}</span>
          ))}
        </div>

        {false && isTarget && !isImageTarget ? (
          <section className="manual-fallback-panel">
            <button className="link-button" type="button" onClick={() => setManualOpen((current) => !current)}>
              {manualOpen ? "Ocultar envio manual" : "Configurar envio manual avançado"}
            </button>
            {manualOpen ? (
              <div className="manual-fallback-body">
                <label htmlFor={`${kind}-manual-codes`}>Códigos manuais de reserva</label>
                <textarea
                  id={`${kind}-manual-codes`}
                  value={manualCodes}
                  onChange={(event) => setManualCodes(event.target.value)}
                  onBlur={() => setManualCodes(parseCodes(manualCodes).join("\n"))}
                  placeholder="Ex: F-14"
                  rows={3}
                />
                <button className="button secondary" disabled={busy || !group.trim() || !senderName.trim() || !manualCodes.trim()} type="button" onClick={submitManual}>
                  Salvar manual
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </form>
    </article>
  );
}
