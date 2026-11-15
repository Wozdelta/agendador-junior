# Resultado da correção local — 14/11/2026

## Executado

- `npm.cmd run build`: aprovado, servidor TypeScript e frontend Vite.
- `npm.cmd run typecheck`: aprovado, servidor, frontend e entrada `api/`.
- `npm.cmd test`: **51 testes de servidor + 9 de frontend aprovados**. Execução final às 22:18, America/Sao_Paulo. A primeira execução restrita falhou ao executar FFprobe; a execução fora do sandbox passou.
- Conexões e Agenda: HTTP 200/JSON no Express e no handler real `api/index.ts`, usando Redis REST simulado no segundo caso.
- Erros: 404 JSON, JSON malformado 400, cron sem credencial 401, inicialização sem serviços 503 JSON; frontend trata texto, HTML, JSON inválido e falha de rede.
- Lote com cinco vídeos de teste, dias consecutivos às 12:00, 20 tarefas independentes e confirmação repetida sem duplicar. Também cinco finalizações Blob simuladas com MP4 real lido por Range, sem FFprobe ou vídeo no disco nesse caminho.
- Concorrência: script Lua real executado com Fengari/Redis simulado; duas instâncias, CAS, lease ativa preservada e recuperação após expiração sem duplicar envio demo.
- TikTok: início OAuth com credenciais fictícias, callback em outra instância, cancelamento, state inválido, expirado e reutilizado. Sem autorização real ou post real.
- `/termos`, `/privacidade` e `.txt`: acesso direto HTTP 200 nos testes. Rewrites inspecionados. Hash do `.txt` no build igual ao de `web/public`; arquivo original sem alterações.
- `git diff --check`: sem erros de whitespace. Os avisos de LF/CRLF são da configuração Git local.

## Publicação observada e limites

As duas rotas publicadas retornaram 500, `text/plain`, `X-Vercel-Error: FUNCTION_INVOCATION_FAILED`; o corpo começava com `A server error has occurred`. O parse sem proteção do React explica o erro apresentado. Sem logs privados não foi possível provar a exceção interna da Function. Não se afirmou que as variáveis, o túnel ou o rewrite eram a causa específica desse 500. Evidências, IDs das requisições e a análise estão no README.

O navegador de QA retornou `The browser access host is unavailable`; não houve teste visual com cliques. Redis, Blob, QStash e OAuth reais continuam pendentes de provisionamento/consentimento e deploy autorizado. O script de setup do QStash não foi executado. Não houve commit, push ou deploy, e o `.env` não foi alterado.

## Arquivos desta intervenção

| Área | Arquivos |
| --- | --- |
| Entrada e configuração | `api/index.ts` (novo), `api/proxy.ts` (removido), `api/tsconfig.json`, `vercel.json`, `package.json`, `.gitignore`, `.env.example` |
| Aplicação/persistência | `server/src/app.ts`, `server/src/config.ts`, `server/src/context.ts`, `server/src/domain/batches.ts`, `server/src/lib/store.ts`, `server/src/lib/redis.ts`, `server/src/lib/links.ts`, `server/src/lib/mediaio.ts`, `server/src/lib/mp4.ts`, `server/src/lib/http.ts`, `server/src/lib/session.ts` |
| Rotas e fila | `server/src/routes/cloud.ts` (novo), `server/src/routes/batches.ts`, `server/src/routes/other.ts`, `server/src/queue/worker.ts` |
| Conectores | `server/src/platforms/facebook.ts`, `server/src/platforms/instagram.ts`, `server/src/platforms/tiktok.ts`, `server/src/platforms/youtube.ts`, `server/src/platforms/types.ts` |
| Frontend | `web/src/lib/api.ts`, `web/src/components/Connections.tsx`, `web/src/components/Agenda.tsx` |
| Testes | `server/test/remote.test.ts`, `server/test/redis.test.ts` (novo), `server/test/blob.test.ts` (novo), `server/test/function.test.ts` (novo), `web/src/lib/api.test.ts` (novo) |
| Setup/documentação | `scripts/configure-qstash.mjs` (novo), `README.md`, `VERIFICACAO.md` (novo) |

O checkout já tinha alterações em `package-lock.json`, `server/package.json`, `web/package.json`, `server/src/domain/model.ts`, `server/src/routes/middleware.ts`, configuração/contexto/store/links, arquivos não rastreados de Redis/mídia e a exclusão staged de `server/src/routes/access.ts`. Foram preservadas e as partes necessárias foram completadas. Nenhum arquivo foi adicionado ao stage por esta intervenção.

## O que preencher no painel

O README contém a tabela exata de variáveis, recursos, callbacks e comandos. Root Directory deve ser a raiz do repositório, preset Vite, output `web/dist` e Fluid Compute habilitado. Conecte Upstash Redis + Vercel Blob público; configure QStash Pay as You Go (1.440 entregas/dia, acima do gratuito) ou use Vercel Pro com cron por minuto. Remova `BACKEND_URL` e `BACKEND_PROXY_SECRET`. Preserve a chave de criptografia e desligue a fila local antiga antes de ativar a de produção.
