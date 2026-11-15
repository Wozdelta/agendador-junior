# Agendador Junior

React/Vite + Express em Vercel Functions, com **agenda manual disponível sem Redis, Blob ou segredos**. Nenhum serviço novo é necessário para abrir a interface, Agenda ou Conexões.

## Correção do bloqueio

`api/index.ts` exigia globalmente Redis, Blob, `TOKEN_ENCRYPTION_KEY` e `CRON_SECRET` antes de atender qualquer rota. Essa condição foi removida. A inicialização agora é preguiçosa: cada rota carrega apenas o estado que utiliza; não grava dados em `/tmp` fingindo persistência na Vercel. Configuração de criptografia ausente ou inválida também não bloqueia telas de leitura.

Erros continuam JSON com status e código, e o React trata texto/HTML/JSON inválido com **Tentar de novo**. Se um Redis já configurado estiver indisponível, Agenda e Conexões mostram o aviso sem apagar dados ou derrubar a agenda manual.

## Funcionalidades e dependências

| Funcionalidade | Necessidade | Alternativa disponível |
| --- | --- | --- |
| Abrir interface, Agenda e Conexões | somente o projeto na Vercel | nenhuma integração obrigatória |
| Agenda manual | armazenamento deste navegador | registrar títulos, nomes de vídeos, descrições e conclusão por rede; exportar JSON |
| Guardar conexões OAuth no servidor | persistência já suportada (Redis opcional), chave AES-256-GCM e credenciais do provedor | publicar diretamente na plataforma |
| Guardar vídeos/capas no servidor | persistência de metadados + Blob opcional | manter os arquivos originais e enviá-los diretamente à plataforma |
| Preparar agendamento nativo | conexão válida e mídia disponível; provedor precisa aceitar a data e o agendamento | preparar pelo painel da própria plataforma |
| Executar tarefa futura do aplicativo | indisponível nesta versão na Vercel | ação manual no horário; não há cron ou processo residente |

A agenda manual funciona também enquanto a API ainda não respondeu. Registra **um vídeo por dia às 12:00 em America/Sao_Paulo**, com status independente por plataforma. Escolher arquivos registra somente os nomes: vídeos e capas não são enviados nem guardados. Os registros ficam no `localStorage` deste navegador, sem sincronização ou notificações. Limpar os dados do navegador remove a agenda; use **Exportar agenda** como cópia. JSON inválido ou armazenamento bloqueado gera erro com nova tentativa, sem sobrescrever dados. Alterações simultâneas em outra aba são detectadas antes de salvar.

## Conexões e agendamento nativo preservados

Redis e Blob permanecem opcionais para quem já os usa; nenhum recurso remoto foi criado ou removido nesta alteração. Conexões criptografadas existentes continuam sendo lidas quando sua persistência está disponível. Sem Blob, conectar OAuth continua possível; sem persistência ou chave válida, apenas a ação de conectar é recusada, com explicação. Tokens e segredos nunca vão para o React.

Em **Agenda → Preparar / retomar agendamentos nativos**, a Function processa somente tarefas compatíveis com agendamento nativo de YouTube/Facebook, por ação explícita. Se um envio exigir mais ciclos, volte a acionar o botão. Apenas **Agendado na plataforma**, após confirmação remota, significa que o provedor assumiu a publicação futura sem o app aberto. O horário efetivo é controlado pelo provedor. Não há polling nem retry automático depois que a requisição termina. Datas fora da janela nativa exigem voltar perto do dia ou usar publicação manual; recusa do agendamento pelo Facebook não ativa uma fila futura escondida.

Instagram e TikTok ficam manuais na Vercel. As conexões são preservadas, mas não se promete Direct Post ou envio futuro à caixa do TikTok. Tarefas antigas não confirmadas recebem alternativa manual, sem apagar seu histórico ou IDs. Antes de publicar manualmente, confira se um envio anterior já apareceu na plataforma. Vídeos que existiam somente no PC não podem ser recuperados pela Vercel: use o arquivo original.

O código local conserva seus conectores e worker para desenvolvimento. Isso não é requisito para usar o site publicado.

## Vercel

- **Root Directory: raiz do repositório (`.` / campo vazio), não `web`.**
- Preset **Vite**, install `npm install`, build `npm run build:web`, output `web/dist`, como em `vercel.json`.
- Para as telas e a agenda manual, **não é necessário cadastrar variáveis**. `APP_URL` pode ser detectado pelo domínio de produção; cadastre explicitamente ao usar OAuth com domínio próprio.
- A Function de preparação nativa conserva `maxDuration: 300`; use Fluid Compute para esse caminho longo. A agenda manual não depende dele.
- Não há configuração cron. Foram removidos o endpoint `/api/cron/tick`, a leitura de `CRON_SECRET` e o script QStash. Se ativou um schedule externo anteriormente, desative-o no painel: o endpoint antigo agora retorna 404. Nada foi alterado remotamente nesta tarefa.

### Variáveis opcionais, somente para os recursos usados

O `.env.example` lista as variáveis ainda lidas pelo código, incluindo as de desenvolvimento local. Sem esses recursos, deixe-as ausentes.

| Recurso | Variáveis |
| --- | --- |
| URLs/callbacks | `APP_URL`, `WEB_ORIGIN`, `PUBLIC_BASE_URL` quando necessário |
| Persistência no servidor | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_PREFIX` (ou os aliases `KV_REST_API_URL` / `KV_REST_API_TOKEN`) |
| Upload persistente | `BLOB_READ_WRITE_TOKEN`, store público, somente para guardar mídia |
| Criptografia OAuth | `TOKEN_ENCRYPTION_KEY`, 32 bytes base64; preserve a chave anterior para ler conexões existentes |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Facebook / Instagram | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`; opções Meta continuam documentadas no exemplo |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`; flags de envio continuam restritos ao fluxo local e somente com permissões aprovadas |

Callbacks do domínio atual:

- `https://agendador-junior.vercel.app/api/oauth/youtube/callback`
- `https://agendador-junior.vercel.app/api/oauth/facebook/callback` (também Instagram)
- `https://agendador-junior.vercel.app/api/oauth/tiktok/callback`

Sem uso de OAuth, a chave de criptografia não é obrigatória. Não cadastre segredos com prefixo `VITE_`. Remova as variáveis antigas `CRON_SECRET`, `QSTASH_TOKEN`, `BACKEND_URL` e `BACKEND_PROXY_SECRET` se não forem usadas por outro projeto. Não habilite integrações ou contrate serviços só para abrir o aplicativo.

`/termos`, `/privacidade` e os arquivos de `web/public`, incluindo o `.txt` do TikTok, continuam preservados com os rewrites existentes.

## Desenvolvimento e testes

```sh
npm install
npm run dev
npm run build
npm run typecheck
npm test
```

Fora da Vercel, o modo local usa JSON/disco quando não há integrações e precisa de FFmpeg/FFprobe para upload local. A demonstração com fila fica restrita ao ambiente local. Consulte [VERIFICACAO.md](VERIFICACAO.md) para resultados e limitações da validação desta revisão.
