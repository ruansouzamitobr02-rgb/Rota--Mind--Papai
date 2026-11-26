# Custos e cobrança — 25/11/2026

## Uso

1. Abra **Custos** e selecione o cliente. Há busca e filtros por situação.
2. Em **Saldo e vencimento**, digite **Valor do cliente · sem taxa**. Esse campo
   define o saldo total do cliente, independentemente do preço de uma rota.
3. Escolha a **data completa de vencimento** e clique **Salvar saldo e vencimento**.
4. Confira o total no cartão: **saldo combinado + taxa de atraso**.
5. Ao receber pelo banco, clique **Registrar pagamento**. A operação quita saldo
   e taxa, preserva o histórico, retira o aviso do cliente e limpa o prazo antigo.
   Defina uma nova data quando combinar o próximo período.

## Taxa e datas

- Após a data escolhida, cada dia de calendário acrescenta **R$ 0,50** de taxa
  simples. O dia do vencimento inteiro permanece no prazo, no horário de São Paulo.
- Exemplo: saldo combinado de R$ 50,00 e três dias de atraso resultam em R$ 51,50.
- O cálculo não altera o saldo principal nem acumula taxa a cada consulta. A mesma
  data e o mesmo saldo produzem a mesma taxa, inclusive depois de reiniciar.
- Sem saldo em aberto, não há taxa. Antecipar ou adiar a data recalcula o prazo.
- Clientes na regra antiga continuam preservados. O novo prazo e a taxa entram
  em vigor quando o administrador confirma a data completa daquele cliente.
  Datas passadas geram a taxa correspondente aos dias decorridos; confira o prazo.
- Ciclos por quantidade, como os dez de Fernando, continuam disponíveis em
  **Regras de rotas**. Eles não geram taxa por calendário. Salvar uma data completa
  muda a cobrança para prazo por data.

## Saldo manual e regras de rotas

O saldo manual persiste entre meses, reinícios e exportação/restauração. Alterar
esse saldo não modifica o preço de uma rota nem apaga os registros anteriores.
Novas rotas validadas continuam acrescentando seu preço configurado, respeitando
antecipações e créditos. Cancelamentos de rotas continuam reduzindo o consumo.

Em **Regras de rotas**, ficam preço por rota, antecipações, botão para zerar
antecipações e ciclo opcional por quantidade. A aba **Histórico** reúne ajustes,
mudanças de prazo, pagamentos e rotas, separados por cliente. Atualizações ao vivo
preservam campos que o administrador está editando.

## Aviso do cliente

Os alertas começam três dias antes do vencimento. Ao fechar, o aviso automático
só reaparece no dia seguinte, no horário de São Paulo, inclusive após sair e
entrar novamente ou usar outro dispositivo. O fechamento é salvo na conta;
o navegador também guarda uma cópia para fechar imediatamente mesmo sem rede.
"Ver aviso" permite consultar os dados de novo no mesmo dia.

No vencimento, a tela informa que o pagamento é hoje e que, a partir do dia
seguinte, o saldo sobe R$ 0,50 por dia. No dia e após o vencimento, exibe a chave
Pix **91980984781**, favorecido **Ruan Souza da Silva**, com botão de copiar.
O recebimento continua sendo conferido pelo administrador no banco.

Durante monitoramento ou envio ativo, o aviso e suas consultas ficam suspensos.
A borda âmbar não intercepta cliques. Registrar o pagamento retira o aviso.

## Bloqueio por pagamento

Em **Custos → cliente → Saldo e vencimento → Acesso ao bot**, use **Bloquear por
atraso** ou **Desbloquear por pagamento**. O bloqueio é manual e só pode ser
ativado para um cliente em atraso. O bloqueio para o bot ativo e impede comandos
de operação/envio também no servidor; não basta chamar a API diretamente.

O cliente continua podendo entrar no site, consultar o débito e copiar o Pix.
Registrar a quitação remove automaticamente esse bloqueio financeiro; desbloquear
manualmente também é possível, sem apagar a dívida. Isso não remove um bloqueio
geral de conta aplicado na área de Clientes. Bloqueios e liberações são auditados.

## Implementação e testes

- Interface: `src/desktop/renderer/admin/CostsPanel.tsx`.
- Cálculo e persistência: `src/imageUsageStore.ts`, `src/shared/billingDeadline.ts`.
- API: `PATCH /api/admin/client-finance/:email`, somente para administradores.
  Todos os campos são validados antes de uma gravação atômica; falha no disco
  desfaz o saldo, a data e os eventos em memória juntos.
- Auditoria da interface: `node scripts/run-desktop-audit.cjs audit-costs.cjs`.
- Testes de saldo, taxa, datas, reinício, renomeação e falha no disco:
  `node --test tests/client-finance.test.js` após `npm run build:main`.
