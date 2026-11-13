# Deploy no Render

Este projeto agora pode rodar como painel web mobile-first no Render.

## Variáveis obrigatórias/recomendadas

- `PANEL_USERS`: obrigatório em produção, no formato `emailadmin:senhaadmin:admin,emailcliente:senhacliente:client`. O terceiro campo define `admin` ou `client`; as senhas não são impressas no log.
- `PANEL_ADMIN_EMAILS`: recomendado para reforçar acesso admin, no formato `emailadmin` ou `email1,email2`.
- `PANEL_SESSION_SECRET`: recomendado/obrigatório para manter sessões estáveis entre restarts. Use um valor longo e aleatório.
- `DATA_DIR`: no `render.yaml` já está como `/data`.
- `BOT_PHONE_NUMBER`: opcional. Use somente se quiser gerar código de pareamento pelo número em vez de QR Code. Formato: `55DDDNUMERO`, sem `+`.
- `KEEP_ALIVE_URL`: opcional, mas recomendado no plano Free para manter o bot acordado quando estiver armado. Use a URL pública do Render, por exemplo `https://seu-servico.onrender.com`.

## Docker/Tesseract

O deploy usa `Dockerfile` para instalar Node.js e Tesseract OCR no servidor do Render. Isso permite que o OCR rode no Render para todos os clientes, sem instalar nada no PC deles.

Pacotes instalados no container:

- `tesseract-ocr`
- `tesseract-ocr-por`

## Comandos locais

Use Node.js 24.x, conforme `.node-version` e `package.json`. O Dockerfile usa a mesma versão principal.

Build:

```bash
npm ci
npm run build
```

Start:

```bash
node dist/server.js
```

No Render, o build/start vem do `Dockerfile`, porque o `render.yaml` usa `env: docker`.

## Atualização de autenticação

Após a atualização da auditoria de setembro de 2026, faça login novamente: tokens do formato anterior deixam de ser aceitos. Mantenha `PANEL_SESSION_SECRET` estável para preservar as novas sessões entre reinícios. Logout, alteração de senha, mudança de permissão e bloqueio invalidam as sessões correspondentes.

Novas gravações de usuários usam hash de senha com scrypt. Arquivos locais existentes não foram modificados pela auditoria; a migração ocorre quando o sistema salva os registros. Usuários criados ou editados no painel mantêm essas alterações após reiniciar. Para contas marcadas como originadas do ambiente, a configuração de `PANEL_USERS` continua sendo usada na inicialização.

## Persistência

O `render.yaml` cria um disco em `/data`. É nele que ficam:

- `auth_info`: sessão do WhatsApp.
- `config.json`: grupos, nome e mensagens salvas.

Sem disco persistente, o WhatsApp pode pedir novo QR Code após deploy/restart e o histórico não fica garantido. Em produção, o servidor exige que `DATA_DIR` seja gravável para não salvar dados em pasta temporária.

Para entregar para outro cliente, apague o disco antigo no Render ou use `Ajustes > Resetar tudo` no painel do usuário. Isso remove sessão do WhatsApp, grupos, nome e mensagens salvas daquele login, e força uma nova conexão por QR Code.

## Render Free

No plano Free, o Render dorme após inatividade. Se você configurar `KEEP_ALIVE_URL`, o servidor faz um ping a cada 10 minutos somente quando o WhatsApp estiver conectado e o monitoramento estiver ativo. Isso ajuda o bot a continuar acordado durante o período em que precisa disparar rápido.

## Uso

1. Abra o link do Render pelo celular.
2. Faça login com um dos emails/senhas configurados em `PANEL_USERS`.
3. Toque em `Conectar WhatsApp`.
4. Escaneie o QR Code pelo WhatsApp.
5. Atualize grupos, salve grupo alvo/teste e mensagens.
6. Use `Iniciar bot` ou `Iniciar teste`.

## Backup externo criptografado no Cloudflare R2

O servidor pode enviar snapshots do `DATA_DIR` para um bucket R2 privado. Os arquivos são compactados e criptografados com AES-256-GCM antes do upload. Mantenha a chave de criptografia fora do GitHub e guarde uma cópia independente para conseguir restaurar os dados em outro serviço.

Configure no Render:

- `R2_ENDPOINT`: endpoint S3 padrão mostrado no Cloudflare R2.
- `R2_BUCKET`: nome do bucket, por exemplo `rota-mind-backups`.
- `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY`: credenciais S3 do token `Object Read & Write`, restrito a esse bucket.
- `R2_BACKUP_ENCRYPTION_KEY`: chave aleatória de 32 bytes codificada em hexadecimal (64 caracteres). Gere-a localmente com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` e guarde-a em um gerenciador de senhas; não a gere dentro do serviço Render.
- `R2_BACKUP_INTERVAL_MINUTES`: intervalo (mínimo 5; padrão 15).
- `R2_BACKUP_RETENTION_DAYS`: retenção dos snapshots diários (entre 7 e 365; padrão 30). O objeto `latest` permanece separado.

O aplicativo grava `rota-mind-backup-v1/latest.rmbak` a cada intervalo e mantém um snapshot diário protegido em `rota-mind-backup-v1/daily/` (não sobrescreve o snapshot do mesmo dia). O endpoint autenticado `GET /api/admin/cloud-backup` informa o status sem exibir segredos; `POST` nesse mesmo endpoint solicita um snapshot manual. O primeiro envio automático ocorre 30 segundos após a inicialização.

### Restaurar em outro serviço Render

1. Crie o novo Web Service com a mesma versão do aplicativo. Em **Disks**, monte um disco persistente em `/data` e configure `DATA_DIR=/data`. Uma pasta gravável no contêiner, sem disco montado, perde os dados ao reiniciar; o painel recusa a restauração nesse caso. Para restaurar do R2, configure também as variáveis `R2_*`, incluindo a mesma `R2_BACKUP_ENCRYPTION_KEY`.
2. Entre no painel como administrador, abra **Config** e aguarde o serviço ficar online.
3. Em **Backup externo**, selecione manualmente o snapshot anterior à migração. Confira o nome e a data; o tamanho sozinho não garante que ele contém os dados desejados. Digite `RESTAURAR DADOS` para continuar.
4. A tela mostra o andamento ao listar, baixar, validar e extrair o snapshot. O status fica salvo para continuar visível após o reinício; em caso de erro, a causa aparece no painel e os dados atuais não são substituídos.
5. Após a validação, o painel fecha conexões, aguarda o encerramento dos workers e reinicia o serviço com os dados do snapshot escolhido. O conteúdo que já existia no novo serviço é preservado no diretório `.cloud-restore-rollback-*` dentro de `DATA_DIR`.
6. A restauração só mostra **Concluída** quando o servidor volta, confere a integridade dos arquivos e abre os bancos. O resultado informa quantos clientes e rotas existem no arquivo. Se a conferência falhar, os dados anteriores são recuperados automaticamente. O administrador que importou mantém sua senha atual; as contas salvas no backup são importadas sem depender de `PANEL_USERS` da conta antiga.

Para um arquivo `.botbackup` salvo no celular, use **Config → Arquivo portátil (iPhone / outro site) → Conferir arquivo → Importar agora** e a senha escolhida na exportação. Esse caminho não precisa de R2, mas também exige disco persistente no Render. Se a sessão precisar ser renovada após reiniciar, entre com o administrador do novo serviço e confira o resultado em **Config**.

Durante a restauração, o serviço fica indisponível por um curto período. Não remova o bucket nem altere a chave de criptografia. Uma cópia da chave precisa ser guardada fora do Render; sem ela, os backups não podem ser descriptografados.
