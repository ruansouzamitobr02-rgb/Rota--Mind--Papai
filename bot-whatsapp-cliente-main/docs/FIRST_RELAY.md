# Primeiro envio em grupos grandes

## Caso observado

O diagnóstico fornecido para um grupo com 1.059 dispositivos mostrou detecção em 2 ms, primeira chamada de relay em 10 ms após iniciar o disparo e retorno do relay em 532 ms. A imagem estava pronta cerca de 9 segundos antes da abertura. Foram registradas 1.052 leituras de chaves.

Esses tempos afastam o OCR como causa desse caso. O intervalo restante inclui trabalho interno do SDK, criptografia para destinatários, gravação de sessões e comunicação com o WhatsApp. Ele não mede somente rede nem comprova que todo esse tempo possa ser eliminado.

## Preparação local

`src/bot/preparedSenderKeys.ts` utiliza as funções do SDK para antecipar a criptografia da distribuição da chave do grupo. A preparação acontece enquanto o grupo está fechado, depois da preparação normal das sessões dos dispositivos.

- Não chama `relayMessage`, `sendMessage` ou `sendNode` e não marca os destinatários como se já tivessem recebido a chave.
- Prepara somente mensagens de distribuição de chave. O texto da rota, seu identificador e o envio real continuam sendo montados pelo caminho normal do SDK.
- Usa o mutex por destinatário e as transações normais do repositório Signal, sem segurar uma transação global entre lotes.
- Trabalha em lotes de 16, cedendo ao processamento de eventos entre eles. A abertura, a desconexão e o cancelamento interrompem os próximos lotes.
- Guarda somente cifras já criptografadas em memória, com limite de 4.096 destinatários. Nenhuma cifra antecipada é gravada em backup ou enviada ao painel.
- Cada cifra é consumida uma única vez e somente para o destinatário e a distribuição de chave exatos, ignorando apenas o padding aleatório do protobuf.
- Captura as versões das sessões efetivamente alteradas durante a operação de criptografia. Mudanças de sessão, identidade, mapeamento de endereços ou membros invalidam a preparação correspondente.
- Cifra ausente, obsoleta ou já consumida segue o caminho normal de criptografia do SDK.
- Parada e reconexão aguardam o lote em andamento antes de fechar o armazenamento da sessão; os próximos lotes são cancelados.

Pausar o monitoramento ou concluir uma rota mantém uma preparação silenciosa a cada 30 segundos enquanto a conexão estiver ativa. Isso não rearma o bot, não publica uma mensagem e não autoriza nenhum disparo. Desconectar ou bloquear financeiramente continua encerrando a conexão e o timer.

`BOT_PREPARE_FIRST_RELAY=false` desativa a antecipação e mantém o caminho normal. O padrão é ativado, sem necessidade de novas variáveis no Render.

## Como conferir

Abra a rota em **Histórico → Diagnóstico do disparo**. Os novos campos separam coordenação, espera por prioridade, criptografia do grupo, preparação de destinatários, quantidade antecipada e acertos/fallbacks da preparação. O retorno da mensagem no grupo continua sendo uma medida separada do término do relay.

Uma preparação aproveitada apresenta **Chaves antecipadas utilizadas** maior que zero. Zero também é normal quando os destinatários já receberam a chave e não precisam de nova distribuição. Pode ocorrer ainda por sessão alterada, grupo aberto durante a preparação, troca de membros ou funções indisponíveis no SDK. O envio normal permanece disponível nesses casos. Os campos são preservados após reiniciar o histórico.

## Verificação local

`npm run bench:first-relay` compara criptografia Signal real com sessões sintéticas, sem conectar ao WhatsApp nem enviar mensagens. Para 1.059 destinatários e três amostras, a mediana local do trecho crítico passou de 79,3 ms para 10,0 ms; a preparação anterior à abertura levou 94,3 ms. Essa redução de 87,4% se refere somente ao trabalho local medido, não ao tempo total até a entrega em produção.

Os testes incluem descriptografia real da primeira rota, descarte do cache durante um reinício, sessão alterada por outra mensagem, uso único, cancelamento entre lotes, retomada normal, preparação sem marcação de entrega e persistência do diagnóstico. Não há garantia de vencer outros participantes: ordem de chegada do evento, rede e processamento do WhatsApp também influenciam.

## Preparação concorrente e conexão sem resposta

Armar, receber um fechamento e executar o timer compartilham a preparação em andamento para o mesmo grupo e socket. Consultas simultâneas de metadados também compartilham uma requisição. Respostas de outro socket, grupo ou geração de preparação não podem repor caches invalidados.

A presença é secundária: uma resposta lenta, cujo limite já era de 2,5 segundos, não segura a criptografia antecipada. Se a descoberta de dispositivos terminar depois da abertura, o aquecimento cede a preparação das sessões ao relay real. O caminho do primeiro envio não espera a conclusão do aquecimento.

O watchdog reutiliza os pings de diagnóstico existentes, sem aumentar a frequência nem enviar mensagens de teste. Só solicita recuperação quando há pelo menos três falhas e 45 segundos sem tráfego recebido. Não reconecta por RTT alto isolado. A recuperação é impedida durante disparo, leitura de imagem, grupo aberto e nos 15 segundos após uma abertura. Há intervalo mínimo de cinco minutos entre recuperações preventivas. O fechamento normal do SDK reconecta e mantém a recuperação de rotas já existente, sem apagar sessões ou chamar `stop()`/`restart()` do bot.

`BOT_SOCKET_WATCHDOG=false` desativa somente a recuperação preventiva. O painel registra tempo desde o último tráfego, falhas de verificação e recuperações da conexão no diagnóstico de cada disparo; esses campos permanecem após reiniciar.

## Histórico e painel durante o primeiro envio

Os timers de histórico de rotas, análises com prévias e telemetria aguardam a pista crítica de envio ser liberada antes de iniciar gravações grandes. O adiamento tem limite de dois segundos a partir da primeira alteração pendente, sem renovar o prazo quando chega outra alteração. `flush()` explícito em parada, backup ou restauração continua gravando imediatamente. A fila compacta de recuperação de disparos mantém sua gravação normal, inclusive durante a corrida, preservando a proteção contra repetição após reiniciar.

As cópias independentes de análises usam `structuredClone`, evitando uma conversão inteira para JSON e de volta antes de começar a gravação. O aviso leve de envio crítico também é emitido quando já existe um timer de painel agendado. O supervisor marca a pista crítica antes de encaminhar o pedido de coordenação ao servidor; a verificação financeira e as regras de prioridade continuam obrigatórias.
