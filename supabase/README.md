# Supabase: instalação e operação

Nada foi criado remotamente. As credenciais não estavam disponíveis no ambiente da implementação. O setup do painel abaixo é necessário antes de publicar a migração.

1. Crie/abra o projeto Supabase. Em SQL Editor → New query, cole `setup.sql` inteiro e execute como administrador do projeto. É reexecutável. Cria tabelas, views, RPCs, grants, RLS e bucket privado; não cria usuários nem inclui e-mails reais.
2. Authentication → Sign In / Providers: habilite Email e desative cadastro público (Allow new users to sign up). Authentication → Users → Add user → Create new user: cadastre o e-mail administrador com uma senha forte exclusiva e confirme o e-mail pela opção do painel. O login agora usa essa senha. Se a conta anterior foi criada apenas para acesso por código, defina uma senha nessa mesma conta pelo gerenciamento do Supabase Auth, preservando o ID do usuário e seus dados. Não coloque a senha no `.env` ou na Vercel.
3. Authentication → URL Configuration: Site URL `https://agendador-junior.vercel.app`. Adicione `http://localhost:5173` aos redirects apenas se usar desenvolvimento local. Os callbacks de redes sociais continuam configurados nos respectivos provedores, não no Supabase Auth.
4. O login por senha não exige SMTP nem envio de e-mail. A conta administradora deve estar cadastrada e confirmada no Supabase Auth.
5. Não é necessário configurar o template Magic Link. As rotas antigas de solicitar/verificar código foram removidas; o formulário envia e-mail e senha para `/api/auth/login`, que valida no Supabase Auth.

6. Project Settings → API / Data API: copie Project URL para `SUPABASE_URL`. Em API Keys, copie Publishable key (`sb_publishable_...`, ou legacy anon) para `SUPABASE_PUBLISHABLE_KEY`, e Secret key (`sb_secret_...`, ou legacy service_role) para `SUPABASE_SECRET_KEY`. A Data API deve estar habilitada para o schema `public`; tabelas e funções só estão concedidas a `service_role`. Nenhuma variável precisa ser `VITE_`.
7. Na Vercel → projeto → Settings → Environment Variables, preencha as quatro variáveis obrigatórias (`Login_ADM`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) em Production. Cadastre `APP_URL=https://agendador-junior.vercel.app`. `Login_ADM` deve coincidir com a conta criada; espaços externos e diferenças de caixa são normalizados. Em Preview use projeto/usuário de teste, sem reaproveitar dados reais inadvertidamente.
8. Para OAuth, preserve `TOKEN_ENCRYPTION_KEY` anterior (32 bytes base64) e as credenciais/redirects de cada provedor já utilizado. Sem chave, agenda/login funcionam, mas gravar tokens OAuth é recusado. `TOKEN_ENCRYPTION_KEY` nunca deve ser rotacionada sem migrar os tokens existentes. `APP_URL` e callbacks não devem apontar para PC/túnel. As opções usadas estão em `.env.example`.
9. Storage → `agendador-media`: confirme **Private**, MIME MP4/QuickTime/JPEG, tamanho máximo 50 MB. Só o fluxo opcional de upload real usa esse bucket. A agenda manual não exige enviar mídia nem criar outro serviço. Não crie políticas públicas para o bucket. SQL já configura uma política restritiva para impedir acesso de JWTs do navegador, mesmo que existam outras políticas permissivas. URLs assinadas são capacidades temporárias e não devem ser compartilhadas. O logout não revoga URLs já emitidas: elas expiram em dez minutos; upload assinado tem a validade definida pelo Supabase.
10. Vercel → General / Build: Root Directory raiz (`.` / vazio), preset Vite, install `npm install`, build `npm run build:web`, output `web/dist`, Node.js 24.x (também fixado no package.json). Preserve `vercel.json` e Fluid Compute para o processamento nativo longo, se utilizado. Depois da revisão local, faça o deploy por sua conta. Alterar variáveis só afeta novos deployments.
11. Entre com e-mail e senha; no mesmo navegador da versão antiga use **Importar registros antigos sem duplicar**. Verifique um lote, exporte uma cópia e confirme que não duplica ao importar novamente. Crie cinco nomes de teste e confira os dias consecutivos às 12:00, status de redes diferentes, logout, `/api/manual` sem sessão (401), `/termos`, `/privacidade` e o `.txt` do TikTok sem login.
12. Depois de validar a migração dos dados necessários, retire da Vercel `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `REDIS_PREFIX`, `BLOB_READ_WRITE_TOKEN`, `BACKEND_URL`, `BACKEND_PROXY_SECRET`, `CRON_SECRET`, `QSTASH_TOKEN`. Não exclua serviços/objetos antigos antes de conferir os backups; este código não faz exclusões remotas nesses serviços. `TIMEZONE` e `PUBLISH_TIME` agora são fixos no código e podem ser removidos; `WORKER_TICK_MS` não é usado em produção.

## Backup de dados antigos do servidor

A leitura da agenda antiga do navegador é preservada pela importação explícita. Para os documentos avançados de um backend anterior, exporte JSON sem publicar os segredos e use a opção autenticada de importação de backup em Configurações. Ela aceita o formato descrito abaixo, ignora IDs existentes e mantém os tokens cifrados. O arquivo deve vir de um backup confiável. Não contém a chave mestra: configure a mesma `TOKEN_ENCRYPTION_KEY` antes de importar conexões. Antes de tentar publicar uma tarefa antiga, confira seu ID/status na plataforma para evitar duplicidade. Tarefas em execução não são retomadas automaticamente.

```json
{"mode":"real","collections":{"batches":[],"tasks":[],"media":[],"connections":[{"id":"doc"}]}}
```

JSONs antigos de `data/real/batches.json`, `tasks.json` e `media.json` são os arrays correspondentes. `connections.json` antigo é um objeto: acrescente `id:"doc"` e coloque-o no array `connections`. Exporte as coleções equivalentes do Redis se ele era utilizado. Importe antes de remover o acesso ao backend antigo. Vídeos do PC não são transferidos pelo JSON. Metadados de Storage só podem apontar para o prefixo do proprietário autenticado. Tokens importados devem ser válidos com a chave atual; a API recusa conexões cifradas com outra chave.

## Verificação executada nesta implementação

- `npm run build` e `npm run typecheck`.
- Suíte completa: 55 testes server e 36 web. FFmpeg/ffprobe dos testes legados precisam de execução permitida no Windows; o sandbox bloqueava sua inicialização. A suíte passou fora desse bloqueio.
- PostgreSQL PGlite executou o SQL completo, reexecução, revisão/CAS, cinco datas ao meio-dia, projeções relacionais e negação de acesso `anon`/`authenticated`.
- Handler Vercel real com Supabase Auth/REST simulados + RPCs executadas no PostgreSQL de teste: senha correta/incorreta, e-mail autorizado/recusado, senha preservada sem trim, verificação da identidade real retornada pelo provedor, bloqueio sem sessão, criação/leitura/importação repetida, alterações concorrentes e revogação no logout.
- DOM React: login, erro, cinco arquivos, gravação no servidor, importação explícita sem apagar localStorage, falha preservando campos, saída, páginas legais públicas. Suíte existente continua validando navegação e layouts por CSS em 1440/1024/768/390/320 px.
- Supabase Storage simulado: cinco uploads, leitura parcial, validação MP4, replay da finalização e recusa de ticket forjado. Nenhum vídeo foi enviado a uma rede real.

Não foi possível validar login no projeto remoto, RLS remoto ou credenciais das plataformas sem as variáveis. Nenhum usuário remoto ou configuração de painel foi criado. As verificações DOM não substituem uma revisão visual em navegador real.

Referências: [login com senha](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [chaves](https://supabase.com/docs/guides/getting-started/api-keys).
