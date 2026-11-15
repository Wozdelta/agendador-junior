# Agendador Junior

React/Vite na Vercel, API Express em Vercel Functions, Supabase Auth e PostgreSQL. O painel exige e-mail e senha de um único administrador. Termos, Privacidade e a verificação TikTok continuam públicos. Não há Redis, Vercel Blob, túnel ou processo residente obrigatório.

## Configuração

Siga [supabase/README.md](supabase/README.md). Execute [supabase/setup.sql](supabase/setup.sql) no SQL Editor. Cadastre as variáveis de [.env.example](.env.example) na Vercel, sem prefixo `VITE_`.

- Node.js: 24.x, como em `package.json` (o SDK Supabase requer Node 22+).
- Root Directory: raiz do repositório (`.` / campo vazio), não `web`.
- Preset: Vite. Install: `npm install`. Build: `npm run build:web`. Output: `web/dist`.
- Preserve os rewrites de `vercel.json`. Não há cron.
- Desenvolvimento: copie `.env.example` para `.env`, preencha Supabase/Login_ADM e use `APP_URL` e `WEB_ORIGIN` como `http://localhost:5173`.

```sh
npm install
npm run dev
npm run build
npm run typecheck
npm test
```

## Dados e autorização

`Login_ADM` é lida somente no servidor, normalizada com trim/lowercase e comparada com a identidade confirmada por `Supabase Auth.getUser`. O login usa `signInWithPassword`, sem criar contas nem enviar códigos. A senha é validada pelo Supabase Auth e não é salva no banco do agendador, nas variáveis da Vercel ou no navegador pelo app. Toda API privada, incluindo callbacks OAuth, valida sessão e administrador antes de usar a chave secreta. Cookies essenciais são HttpOnly/SameSite=Lax e Secure na Vercel. Uma sessão revogada no banco deixa de acessar a API imediatamente, mesmo com uma cópia do cookie anterior. A sessão do aplicativo dura até sete dias; o token Supabase é renovado no servidor quando necessário.

RLS e permissões negam acesso direto de `anon`/`authenticated` às tabelas e RPCs. Só o backend autorizado usa a chave secreta. Conexões OAuth continuam AES-256-GCM: a chave dedicada `TOKEN_ENCRYPTION_KEY` tem prioridade e deve ser preservada se já era usada. Sem ela, o servidor deriva uma chave de 32 bytes de `SUPABASE_SECRET_KEY` com HKDF-SHA256 e contexto exclusivo de OAuth, dispensando cadastrar outro segredo. Nessa configuração, preserve também o segredo do Supabase: sua troca exige reconectar as redes ou migrar a criptografia antes. Nenhum segredo é compilado no React. Alterar Login_ADM não transfere os dados de uma conta para outra.

Em Conexões, credenciais do aplicativo e autorização da conta são estados separados. Com o Supabase e as credenciais configurados, as quatro redes permitem iniciar OAuth, sem exigir Storage ou processamento futuro. Instagram usa o Facebook Login e a Página vinculada ao perfil profissional. O início por POST faz a validação em JSON antes de navegar ao provedor, preservando a tela quando houver erro. Os cartões mostram o requisito exato quando falta uma configuração; não classificam esse bloqueio como modo manual. A conclusão do consentimento no provedor é necessária para vincular uma conta.

Use **Entrar com Google**, **Entrar com Facebook** ou **Entrar com TikTok**. O login acontece na página oficial, na mesma aba; o app não pede nem guarda senhas das redes. No Google, escolha a conta e autorize o acesso ao canal. Para Instagram, entre com Facebook e escolha a Página vinculada diretamente no cartão do Instagram. Após o callback, a tela consulta as contas persistidas antes de confirmar sucesso; cancelar mantém as conexões anteriores. Conectar uma conta não publica vídeos por si só.

A agenda manual é o fluxo inicial: guarda nomes e textos, sem transferir arquivos. Os registros são salvos na conta Supabase. O botão **Importar registros antigos sem duplicar** importa a agenda existente do navegador por IDs estáveis, sem apagar sua cópia local. A importação é explícita e pode ser repetida. Exportação JSON continua disponível. A edição da descrição é salva ao sair do campo. Em falha, mantenha a tela aberta, corrija/recarregue a conexão e tente novamente; o texto digitado não é limpo.

`manual_batches`, `manual_items` e `manual_platforms` são a projeção relacional da agenda, gravada na mesma transação dos documentos. Os payloads completos de lotes avançados, tarefas, mídia, conexões criptografadas e idempotência ficam em `scheduler_records`, particionados por proprietário, modo e coleção. As views `integration_*` permitem consultar itens, textos e status sem perder campos do domínio Node existente. O controle de revisão com bloqueio de linha no PostgreSQL evita sobrescritas concorrentes; conflitos são reaplicados sobre a versão atual.

## Upload e plataformas

**Upload e agendamento nativo** é um fluxo opcional, separado da agenda manual. Usa o bucket privado `agendador-media` no Supabase Storage: upload direto por URL assinada, progresso real, validação MP4/MOV/JPEG no servidor por intervalos de bytes e download assinado por dez minutos. O setup limita arquivos a 50 MB; para ampliar, ajuste o bucket, `MAX_VIDEO_MB` e os limites do plano contratado. O upload atual é direto, sem retomada automática após perda de conexão; selecione o arquivo novamente para tentar outra vez. Nenhum vídeo atravessa o corpo da Function da Vercel.

YouTube/Facebook conservam seus agendamentos nativos. Em **Agenda → Preparar / retomar agendamentos nativos**, a Function trabalha por ação explícita e respeita leases/idempotência. Só a confirmação **Agendado na plataforma** significa que a rede assumiu a publicação futura. Falhas, janelas de agendamento e envios incompletos exigem nova ação no painel. Não há timer, cron nem execução futura automática da fila. Instagram e TikTok permanecem manuais na Vercel; flags de permissões TikTok não prometem envio futuro automático. Confira a rede antes de repetir qualquer publicação cujo resultado esteja indefinido.

Callbacks permanecem:

- `https://agendador-junior.vercel.app/api/oauth/youtube/callback`
- `https://agendador-junior.vercel.app/api/oauth/facebook/callback` (também Instagram)
- `https://agendador-junior.vercel.app/api/oauth/tiktok/callback`

Contas antes persistidas somente em JSON/Redis não são automaticamente transferidas ao trocar o backend. Use a importação de backup descrita no guia antes de retirar o serviço antigo, ou reconecte as contas. Arquivos só existentes no PC precisam ser enviados novamente; objetos Blob antigos não são apagados remotamente pelo aplicativo. As classes antigas de persistência foram mantidas para compatibilidade de testes e leitura de backups; variáveis Redis/Blob não selecionam mais o backend de produção.

## Interface

O motor da navegação Liquid Stretch fica em `web/src/lib/liquid-motion.ts`, com componente `web/src/components/LiquidNav.tsx`. A prévia local de quatro segundos usa `/#/motion` e agora também exige login. O fluxo manual preserva um vídeo por dia às 12:00 em `America/Sao_Paulo`, ordem dos vídeos e situação independente por rede. Consulte o guia Supabase para os testes desta migração; o histórico visual anterior está em `VERIFICACAO.md`.
