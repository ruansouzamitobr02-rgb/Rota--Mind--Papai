# Operação e desempenho

O envio continua respeitando as prioridades entre clientes, as condições de bairro/região, os limites de paradas/pacotes, o bloqueio financeiro e a proteção contra duplicidade. A otimização não considera uma tentativa como entrega confirmada pelo WhatsApp.

## Caminho do envio

- A rota identificada segue para o envio sem esperar a geração da foto de prévia. A prévia chega depois e fica vinculada à análise correta, inclusive no histórico.
- Tarefas secundárias conferem novamente se há um disparo em andamento antes de executar. Um timer iniciado antes da abertura não pode invadir o momento do relay.
- As variantes de imagem são geradas sob demanda. Leituras alternativas continuam disponíveis quando necessárias; a primeira leitura não paga antecipadamente pelo processamento de todas elas.
- O cache continua compartilhando o resultado da mesma foto entre clientes. No Render/Linux, a liberação da fila avisa os interessados pelo sistema de arquivos. Um timer cobre eventos perdidos e sistemas sem notificações. No Windows, o timer evita uma falha nativa do observador de diretórios do libuv.

## Capacidade do servidor

`src/services/runtimeCapacity.ts` considera afinidade de CPU, quotas cgroup v1/v2 e limite de memória. O resultado aparece no início dos logs e em `/api/ping`, no campo `performance`.

`OCR_GLOBAL_CONCURRENCY` limita imagens simultâneas; `OCR_VARIANT_CONCURRENCY` limita variantes por imagem. São tetos, limitados também pelos recursos disponíveis. Um segundo conjunto de vagas, compartilhado pelos processos dos clientes, limita a quantidade total de leitores pesados. Assim, oito imagens com quatro variantes não criam 32 leitores disputando oito CPUs. Cada leitor nativo usa uma thread OpenMP; a fila utiliza os demais núcleos com outros leitores.

O processo de OCR usa prioridade de CPU inferior à do socket, podendo usar os núcleos ociosos e cedendo tempo de execução quando chegam eventos de abertura. O número de vagas do OCR não altera a prioridade comercial de nenhum cliente.

Não é necessário adicionar variáveis no Render para ativar essas mudanças. O plano contratado não foi alterado.

## Verificação

`npm run bench:operational` mede a preparação das duas primeiras leituras quando existem seis variantes possíveis. Alterna os cenários para reduzir o efeito de aquecimento, descarta a primeira amostra e informa a mediana de cinco amostras. Não inclui reconhecimento OCR, rede, prioridade entre clientes nem confirmação do WhatsApp.

Na medição local de desenvolvimento (Windows, 28 CPUs lógicas), a tabela clara passou de 3941,6 ms para 1070,2 ms e a escura de 5167,7 ms para 524,2 ms nessa etapa. Foram gerados, respectivamente, 3 → 1 e 4 → 1 arquivos. Esses resultados não são uma previsão do tempo total em produção.

Os testes de operação cobrem quotas de CPU/memória, limites dos leitores, liberação de vagas, geração sob demanda, tarefas secundárias durante o relay, prévia antiga e envio sem esperar uma prévia lenta. Os testes existentes continuam cobrindo prioridade, cancelamento, reconexão, imagens reais, duplicidade e persistência.
