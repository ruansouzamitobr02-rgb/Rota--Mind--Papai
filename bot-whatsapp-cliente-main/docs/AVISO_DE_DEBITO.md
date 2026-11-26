# Aviso de débito — 25/11/2026

Esta etapa acrescenta somente a comunicação de saldo vencido. A reformulação de
Custos, cobrança de taxas e integração bancária/Pix ficaram para outra atualização.

- O cliente com saldo vencido vê o valor real em aberto e pode fechar o aviso.
- O lembrete reaparece após cinco minutos, enquanto a pendência continuar.
- Uma borda âmbar indica a pendência sem bloquear o uso do bot.
- Com o bot armado, aguardando confirmação de envio, durante ações ou com análise/incidente aberto, o aviso fica
  oculto e suas consultas periódicas são interrompidas. A borda não recebe cliques.
- O administrador registra a quitação pelo botão já existente em Custos. O
  pagamento é propagado ao cliente e retira aviso e borda. A consulta também é
  renovada a cada minuto fora do monitoramento e ao voltar ao app/à internet.
- “Já pagou? Atualizar situação” apenas consulta o servidor. Não registra pagamento.

O vencimento utiliza o dia já configurado e o período ainda não pago, no horário
de São Paulo. Um saldo antigo não passa a vencer no futuro só porque virou o mês.
Clientes que pagam por quantidade, como Fernando, mantêm seu ciclo configurado;
não recebem cobrança por calendário antes de atingir a quantidade de rotas.

Código principal: `src/shared/billingDeadline.ts`, `src/imageUsageStore.ts`,
`src/desktop/renderer/components/ClientDebtNotice.tsx` e `/api/billing/status`
em `src/server.ts`. A API exige login e retorna apenas o financeiro da conta
autenticada, ignorando tentativas de selecionar outro cliente pela URL.

Validação: seis testes em `tests/client-debt-notice.test.js`, incluindo HTTP real
com autenticação e quitação, e auditoria da interface:

```powershell
npm run build
npm run build:main
node --test tests/client-debt-notice.test.js
node scripts/run-desktop-audit.cjs audit-client-debt.cjs
```

A auditoria verifica layout em celular, adiamento, retorno após cinco minutos,
ocultação durante monitoramento, ausência de consultas enquanto armado e
proteção contra uma resposta antiga ressuscitar o débito após o pagamento.
