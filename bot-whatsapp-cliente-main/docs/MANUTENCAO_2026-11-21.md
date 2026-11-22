# Revisão de confiabilidade — 21/11/2026

Revisão do fluxo WhatsApp, abertura de grupos, leitura OCR, processos isolados,
persistência, financeiro, restauração, sessão do painel, retomada do app e distribuição.
As correções se concentram em falhas reproduzidas e mantêm o envio por evento de
abertura, sem acrescentar consultas de rede à leitura normal de cada imagem.

## Correções

| Área | Problema encontrado | Comportamento corrigido | Arquivos |
| --- | --- | --- | --- |
| Comandos do bot | Uma consulta iniciada antes de Parar podia terminar e armar o monitoramento novamente. | Operações conferem sua geração, conexão e ciclo após as esperas; comandos antigos são cancelados. | `src/bot/connection.ts` |
| Fila do cliente | Parar aguardava comandos lentos. Um encerramento concorrente também podia interferir na conexão seguinte. | Parar tem prioridade; os comandos seguintes aguardam o encerramento. Um ciclo antigo não desarma o novo. | `src/bot/botWorker.ts`, `src/bot/connection.ts` |
| Processos isolados | Canais IPC fechados e inicialização sem resposta podiam deixar chamadas presas ou processos órfãos. | Tratamento de erro síncrono e assíncrono no IPC; limite de 30 segundos para inicializar; recuperação de desconexão; intervalo crescente entre falhas repetidas, até 30 segundos. Respostas de processos antigos são ignoradas. | `src/bot/workerIpc.ts`, `src/bot/botProcessProxy.ts`, `src/bot/ocrIsolated.ts` |
| OCR | Uma rejeição anterior podia comprometer a fila do worker. | A próxima análise pode prosseguir após a falha; a liberação de recursos e o encerramento tratam rejeições. | `src/bot/ocrWorker.ts` |
| Histórico | JSON corrompido podia virar histórico vazio e depois ser sobrescrito. | Recupera `.bak` válido. Se os dois arquivos estão inválidos, recusa a gravação em vez de substituir os dados por vazio. O histórico OCR passa a manter cópia anterior. | `src/storageJson.ts`, `src/bot/routeStore.ts`, `src/bot/ocrAnalysisHistoryStore.ts` |
| Financeiro | Falha de gravação podia deixar pagamento ou consumo de antecipações alterado apenas na memória. | A memória retorna ao último estado gravado; repetir a operação não consome uma antecipação adicional. Registros inválidos tentam a cópia de segurança. | `src/imageUsageStore.ts` |
| Ajuste manual de saldo | O valor editado era salvo, mas ignorado na composição do saldo. | O ajuste aparece para administrador e cliente. Novas rotas somam o preço configurado; exclusões descontam; pagamento quita o ajuste. A troca de email preserva o saldo. Todas as modalidades de rota validada continuam cobradas. | `src/imageUsageStore.ts` |
| Backup e restauração | Falha na criação do diretório temporário podia manter a operação permanentemente em andamento. Erros de stream podiam gerar rejeições soltas. | Libera o estado para nova tentativa e encerra os streams antes de limpar arquivos temporários. Um registro de restauração corrompido interrompe a inicialização para preservar os dados. | `src/services/cloudBackup.ts` |
| Tarefas do servidor | Erros em tarefas agendadas de prioridades e lembretes não tinham tratamento no chamador. | Os erros são registrados sem deixar rejeições ou exceções escaparem dessas tarefas. | `src/server.ts` |
| Dependências e imagem de produção | Dependências com alertas conhecidos; `include=dev` na configuração do npm contrariava a remoção das ferramentas de desenvolvimento. | Atualizações de segurança no lockfile, Electron 45.4.1 e overrides por faixa de versão do minimatch, preservando consumidores antigos. Docker instala explicitamente ferramentas de build e as remove da imagem final. | `package.json`, `package-lock.json`, `.npmrc`, `Dockerfile` |

## Verificação realizada

- Base anterior: 364 testes, sendo 357 aprovados, três falhas e quatro testes OCR opcionais não executados.
- Estado final: **380 testes aprovados, zero falhas e zero ignorados**, com `RUN_REAL_OCR_TESTS=1`.
- Os três problemas da base foram tratados: dois usos do ajuste de saldo ignorado e uma expectativa antiga de teste incompatível com a cobrança de todas as modalidades.
- Novos testes exercitam cancelamento durante consultas, comandos concorrentes, IPC fechado, inicialização sem resposta, recuperação de arquivos, erro de disco, antecipações, pagamentos e nova tentativa de backup/restauração.
- Testes HTTP existentes verificaram exportação/importação, reinícios, preservação de clientes e login, disco persistente e diagnóstico de falhas.
- Auditorias de interface em janela oculta verificaram retomada após segundo plano, renovação da conexão de eventos, preservação do login e formulário, edição de região, imagens autenticadas e recuperação de erro de renderização.
- A interface de rotas apagadas passou nos testes de filtros, relatórios, CSV e atualização de uma rota já aberta.
- O pacote Windows foi criado e seus módulos nativos SQLite e Sharp executaram corretamente no Electron empacotado.
- `npm audit` e `npm audit --omit=dev`: **zero vulnerabilidades conhecidas na consulta realizada**.
- Instalação limpa de produção com o lockfile: SQLite e Sharp funcionaram; Electron e Vite não foram instalados.

## Como repetir

No diretório `bot-whatsapp-cliente-main`:

```powershell
npm run verify

# Inclui os testes que executam o motor OCR real:
$env:RUN_REAL_OCR_TESTS = '1'
npm run verify
Remove-Item Env:RUN_REAL_OCR_TESTS

# Auditorias da interface, após o build e build:main feitos pelo verify:
node scripts/run-desktop-audit.cjs audit-web-resume.cjs
node scripts/run-desktop-audit.cjs audit-deleted-routes.cjs
node scripts/run-desktop-audit.cjs

# Pacote Windows e módulos nativos:
npx electron-builder --dir --win
node scripts/audit-packaged-runtime.cjs
```

Nesta máquina Windows, a instalação padrão tentou compilar o SQLite e encontrou
ausência das ferramentas C++ do Visual Studio. A instalação limpa usada para
validar os binários precompilados foi `npm ci --include=dev --ignore-scripts`,
seguida por `node node_modules/electron/install.js`. SQLite, Sharp e Electron
foram então exercitados pelos testes acima. Isso não altera o comando de build
do Docker, que usa o estágio completo `node:24-bookworm`.

## Limites da verificação

Os testes de WhatsApp simulam eventos, atrasos, respostas e falhas; esta revisão
não enviou mensagens nos grupos reais de clientes. A auditoria de retomada usa
Chromium/Electron e não substitui uma rodada em iPhone físico. O Docker local
estava sem daemon disponível, portanto o build Linux completo depende do deploy
do Render; a instalação de dependências de produção foi conferida separadamente.

WhatsApp, internet, OCR e hospedagem podem falhar. A revisão reduz falhas
conhecidas e melhora recuperação e preservação dos dados; não promete ausência
absoluta de falhas nem entrega de mensagem sem confirmação do WhatsApp. Disparos
com resultado incerto após uma queda continuam protegidos contra reenvio cego,
para evitar duplicidade. Disco persistente e backups válidos continuam necessários.
