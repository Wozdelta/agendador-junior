# Agendador Junior

React/Vite + Express, com um vídeo por dia de cada lote às **12:00 em America/Sao_Paulo** e status independente por plataforma. Esta correção é local: não houve commit, push, deploy nem criação de recursos remotos.

## Diagnóstico comprovado

Consulta HTTP em 14/11/2026, horário de São Paulo:

| Tela | Requisição publicada | Status | Content-Type | Resposta |
| --- | --- | --- | --- | --- |
| Conexões | `GET https://agendador-junior.vercel.app/api/connections` | 500 | `text/plain; charset=utf-8` | `A server error has occurred` + `FUNCTION_INVOCATION_FAILED` |
| Agenda | `GET https://agendador-junior.vercel.app/api/tasks` | 500 | `text/plain; charset=utf-8` | mesmo erro |

Ambas tinham `X-Vercel-Error: FUNCTION_INVOCATION_FAILED`. IDs: `gru1::mvqp5-1794704316815-e224c5c87df7` e `gru1::fwg2t-1794704317637-d0993354aef9`. O frontend fazia `JSON.parse(text)` sem validar nem proteger o parse: isso comprova a causa da mensagem `Unexpected token 'A'`.

O rewrite anterior encaminhava `/api/*` para `api/proxy.ts`, que usava `BACKEND_URL` e `BACKEND_PROXY_SECRET`, repassando também erros de texto do upstream. Variáveis ausentes nesse código retornavam JSON 503, portanto não explicam isoladamente o texto 500 observado. Logs privados, variáveis remotas e Root Directory efetivo não estavam acessíveis: não havia conector Vercel autenticado nem `.vercel/project.json`. A exceção interna da Function **não foi comprovada**. Não atribuímos a falha ao túnel, rewrite ou formato de export sem evidência.

O proprietário informou Root Directory `web`, que exclui a configuração e `api/` da raiz. É necessário mudá-lo para a raiz; a resposta de uma Function publicada impede afirmar que havia apenas uma rota estática ausente. A configuração efetiva do deploy deve ser conferida no painel.

## Implementação

- `api/index.ts` é uma Function Node com handler padrão e inicialização dentro de uma barreira JSON de erro. Usa o Express existente, sem proxy ou servidor local. Cada requisição tem seu contexto para evitar mistura de estado entre invocações concorrentes do Fluid Compute.
- `/api/...` continua no mesmo domínio. Erros da aplicação usam status e `{ error, code, details? }`. Falhas da própria infraestrutura ainda podem produzir texto; o React trata texto/HTML/JSON inválido e mantém **Tentar de novo** em Conexões e Agenda.
- Upstash Redis persiste rascunhos, conexões, fila, idempotência e nonces OAuth. CAS com revisão e Lua atômica reaplica conflitos concorrentes, evitando sobrescritas silenciosas. Tokens continuam AES-256-GCM, com state OAuth criptografado, expiração e consumo atômico entre instâncias.
- Vídeos/capas vão direto do navegador para **Vercel Blob público**, usando multipart. O servidor valida cabeçalhos e metadados por intervalos de bytes em JS, sem FFmpeg na Vercel. Capas PNG são convertidas para JPEG no navegador. Os conectores leem o Blob; Instagram recebe a URL diretamente. A API não recebe arquivos grandes.
- Multipart recupera partes com falhas durante o upload; não promete retomar após fechar/recarregar a página. A finalização é idempotente por ticket; pode ser repetida se a resposta se perder. Objetos abandonados podem precisar de limpeza pelo painel Blob. Rascunho incompleto não é publicado.
- QStash chama `/api/cron/tick` a cada minuto com `Authorization: Bearer CRON_SECRET`. O worker não usa timer na Vercel; retoma fases, IDs e tentativas persistidas. Cada tarefa tem lease maior que o limite da Function; outra instância só a recupera após expirar, reconciliando o resultado remoto. IDs determinísticos impedem duplicação ao confirmar o mesmo lote. Resultado incerto sem verificação exige revisão manual.
- YouTube transfere blocos de 8 MB na Vercel; TikTok persiste progresso dos blocos. HTTP e execução têm orçamento inferior ao limite rígido de 300s. Tentativas temporárias usam backoff e estados por plataforma. A próxima chamada continua o trabalho após encerramento da anterior.
- TikTok manual permanece disponível. `video.upload` habilita envio à caixa de entrada, que o criador finaliza no app; `video.publish` exige aprovação, elegibilidade e consentimento explícito para Direct Post. Os dois flags de aprovação ficam `false` por padrão.

O horário planejado permanece meio-dia. YouTube/Facebook são preparados antecipadamente quando há agendamento nativo; Instagram/Direct Post publicam pela fila a partir do horário. Latência e processamento das redes impedem garantia do segundo exato. Após 20 minutos de tolerância, itens atrasados pedem reagendamento. A sequência de um vídeo/dia vale por lote, como no projeto original.

## Vercel: configuração exata

1. **Root Directory: raiz do repositório (`.` / campo vazio). Remova `web`.**
2. **Framework Preset: Vite**, pode manter.
3. Install Command `npm install`; Build Command `npm run build:web`; Output Directory `web/dist`. Já estão no `vercel.json` da raiz; remova overrides antigos conflitantes.
4. Habilite **Fluid Compute**. A Function usa `maxDuration: 300`, orçamento interno de 240s e lease de 6 minutos. Hobby sem Fluid tem limites menores.
5. Em Storage/Marketplace conecte **Upstash Redis** com REST e persistência (sem expulsão de registros da fila) e **Vercel Blob público**. Redis é necessário para atualizações atômicas; Blob não substitui banco/fila. Prefira região próxima à Function.

Cadastre em **Environment Variables → Production**:

| Variável | Preencher com |
| --- | --- |
| `APP_URL` | `https://agendador-junior.vercel.app` |
| `WEB_ORIGIN` | `https://agendador-junior.vercel.app` |
| `PUBLIC_BASE_URL` | `https://agendador-junior.vercel.app` |
| `UPSTASH_REDIS_REST_URL` | URL REST da integração Redis |
| `UPSTASH_REDIS_REST_TOKEN` | token Redis com escrita |
| `BLOB_READ_WRITE_TOKEN` | token da conexão Blob |
| `TOKEN_ENCRYPTION_KEY` | chave anterior; se não houver tokens, nova chave de 32 bytes base64 |
| `CRON_SECRET` | segredo aleatório independente, compartilhado só com o scheduler |
| `REDIS_PREFIX` | `agendador-junior-prod` |
| `TIMEZONE` | `America/Sao_Paulo` |
| `PUBLISH_TIME` | `12:00` |
| `TIKTOK_VIDEO_UPLOAD_APPROVED` | `false` até aprovação de `video.upload` |
| `TIKTOK_DIRECT_POST_APPROVED` | `false` até aprovação de `video.publish` |

Os aliases `KV_REST_API_URL` / `KV_REST_API_TOKEN` são aceitos no lugar das variáveis Upstash; não configure ambos com bancos diferentes. Os demais limites do `.env.example` têm defaults. Não cadastre `VERCEL=1` manualmente: é definido pela plataforma. Nunca use `VITE_` em segredos.

Preencha também as credenciais das redes desejadas e cadastre estes callbacks nos consoles dos provedores:

| Provedor | Segredos | Variável de callback |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `GOOGLE_REDIRECT_URI=https://agendador-junior.vercel.app/api/oauth/youtube/callback` |
| Meta / Instagram | `META_APP_ID`, `META_APP_SECRET` | `META_REDIRECT_URI=https://agendador-junior.vercel.app/api/oauth/facebook/callback` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `TIKTOK_REDIRECT_URI=https://agendador-junior.vercel.app/api/oauth/tiktok/callback` |

`META_GRAPH_VERSION=v27.0` mantém o default do projeto; `META_LOGIN_CONFIG_ID` é opcional para Login for Business. Redes sem credenciais permanecem desconectadas. Use stores/prefixos e callbacks próprios em Preview para não executar tarefas reais em previews.

Remova **`BACKEND_URL` e `BACKEND_PROXY_SECRET`** da Vercel: não são usados. O `.env` local não foi alterado. Dados antigos de `data/` não são migrados automaticamente: preserve a chave de criptografia e faça migração controlada, ou reconecte contas e recrie lotes. Desligue a fila local antiga antes de ativar o scheduler de produção; não replique tarefas já publicadas.

### Acionamento e planos

O [Cron nativo Hobby](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing) permite apenas execução diária e precisão por hora; não atende meio-dia com retries/polling. Por isso o `vercel.json` não inclui cron incompatível. [Functions Hobby com Fluid Compute permitem 300s](https://vercel.com/docs/functions/configuring-functions/duration).

A configuração preparada usa [QStash Schedules](https://upstash.com/docs/qstash/features/schedules), com processamento integral nas Functions da Vercel. Requer **QStash Pay as You Go**: 1.440 entregas/dia ultrapassam as 1.000/dia gratuitas; [cada retry também conta](https://upstash.com/pricing/qstash). Blob, Redis e Functions possuem quotas/custos próprios. Alternativa: **Vercel Pro**, com cron `* * * * *` para `/api/cron/tick` usando o mesmo `CRON_SECRET`; não ative os dois schedulers.

Após um deploy futuro autorizado, configure pelo painel Upstash ou execute uma vez:

```sh
# APP_URL, CRON_SECRET e QSTASH_TOKEN no ambiente ou .env local
node scripts/configure-qstash.mjs
```

O script cria/atualiza `agendador-junior-tick`: POST para `https://agendador-junior.vercel.app/api/cron/tick`, cron `* * * * *`, header encaminhado `Authorization: Bearer <CRON_SECRET>` e três retries. Configure timeout de entrega que comporte a Function (até 300s, plano QStash compatível). O script não roda no build e **não foi executado nesta tarefa**. `QSTASH_TOKEN` só é necessário no setup, não no runtime da Vercel. Monitore logs/DLQ do QStash e logs da Vercel. O destino do scheduler precisa estar acessível, sem bloqueio por Deployment Protection.

## URLs públicas

`/termos` e `/privacidade` têm rewrites explícitos para o SPA e não dependem da API. `web/public/tiktokx1Qmn4YclvyNgFAczoIKzXwE4yeNCzoz.txt` permanece intacto, copiado pelo Vite para a raiz do build. Não existe mais rewrite genérico capturando `.txt` ou convertendo APIs ausentes em HTML. Outros arquivos de `web/public` também são publicados literalmente.

## Desenvolvimento e verificação

Resultado desta intervenção: build e typecheck aprovados; **51 testes de servidor e 9 de frontend passaram**. A lista de arquivos e as evidências completas estão em [VERIFICACAO.md](VERIFICACAO.md).

```sh
npm install
npm run dev
npm run build
npm run typecheck
npm test
```

Sem Redis/Blob, o desenvolvimento continua com JSON/arquivos em `data/` e timer em `server/src/index.ts`. Use `WEB_ORIGIN=http://localhost:5173` localmente. FFmpeg/FFprobe são necessários só no caminho local e nas fixtures de teste.

Testes cobrem fluxos originais, datas/limites, cinco vídeos consecutivos às 12:00, confirmação repetida sem duplicar, status/falhas independentes, reconciliação, Conexões/Agenda, JSON malformado, rota ausente, origem e cron autenticado. Testes de concorrência executam o script Lua real com Fengari e Redis REST simulado, incluindo duas instâncias e recuperação de lease. Callback TikTok: credenciais fictícias, cancelamento, state inválido, expirado e reutilizado; nenhum post real.

Não foi possível fazer QA visual: a tentativa do navegador retornou `The browser access host is unavailable`. Cliques nas telas, upload real Blob, Redis/QStash reais e consentimento OAuth real permanecem pendentes de serviços configurados e deploy futuro. As respostas publicadas foram verificadas por HTTP. O trabalho local não altera o site publicado.
