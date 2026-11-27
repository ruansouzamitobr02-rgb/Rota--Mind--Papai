# Tabelas de rotas: bairros completos e letras M/N

Correção de 27/11/2026, reproduzida com a imagem real em `tests/fixtures/nov27-route-table.png`.

## Falha reproduzida

Na linha M-22, o OCR reconhecia o texto completo, mas as caixas de palavras tinham alturas diferentes. A reconstrução separava “Parque” de “Vicente Gonçalves Dias”; a preferência completa não correspondia, embora a rota aparecesse na seleção manual. Outra leitura da mesma linha reconhecia M-22 como 1-22.

## Comportamento

- A reconstrução tolera pequenas diferenças de altura na mesma linha. Cada palavra ainda precisa ser compatível com todas as outras da linha para não juntar bairros vizinhos.
- Na tabela ROTA/AT/CLUSTER/BAIRRO/ID, o campo ID encerra a coluna BAIRRO. Não é interpretado como parte do bairro ou como quantidade.
- Uma linha completa, com bairro explícito e AT, pode ser selecionada automaticamente mesmo quando a tabela não tem paradas/pacotes. Limites configurados e a distinção de região do Centro continuam em vigor.
- Quando uma gaiola M/N tem confiança baixa ou leituras discordantes para o mesmo AT, são feitas duas leituras apenas da área das gaiolas, com tratamentos distintos e alfabeto restrito. Usa-se o modelo inglês para os códigos; os nomes continuam no modelo português.
- A correção só se propaga para a mesma linha identificada pelo AT completo, com o mesmo número. Não há troca global de M por N, nem associação pelo bairro presumido. Leituras ampliadas discordantes não autorizam envio automático.
- Imagens sem a ambiguidade não fazem essa conferência adicional. Os processos continuam sujeitos ao controle global de CPU; o motor nativo usa uma thread. Falhas na conferência mantêm o tratamento normal de evidências.
- A versão do cache compartilhado foi alterada para não reutilizar reconstruções anteriores.

## Validação

Execute `npm run build:main` e, com `RUN_REAL_OCR_TESTS=1`, `node --test tests/*.test.js`.

Os testes incluem a imagem real, uma versão ampliada e recomprimida, M/N distintos, ATs diferentes, número divergente, palavras de linhas vizinhas, limites/regiões e o fluxo sem intervenção: análise, espera pelo grupo e envio por transporte simulado. Não enviam mensagens reais ao WhatsApp.

Imagens ilegíveis ou contraditórias ainda podem exigir revisão; o OCR não tem garantia absoluta de acerto.
