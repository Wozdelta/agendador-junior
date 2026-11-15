# Agendador Junior

Aplicativo para agendar **em lote** vídeos curtos no **Facebook Reels**, **YouTube Shorts**, **Instagram Reels** e **TikTok**: um vídeo por dia corrido, às **12:00 (America/Sao_Paulo)**, com textos e capa independentes por rede, fila persistente no backend e agenda com o estado de cada publicação. Roda 100% local ou com a interface hospedada na Vercel (seção 2).

- Frontend: React + Vite + TypeScript (`web/`) — páginas públicas `/`, `/termos` e `/privacidade`
- Backend: Node.js + Express + TypeScript (`server/`)
- Proxy da Vercel: `api/proxy.ts` + `vercel.json`
- Dados: arquivos JSON com gravação atômica e mídia em diretório local (`data/`, fora da pasta pública)

---

## 1. Instalação e comandos

Requisitos: **Node.js 20+** (testado no 24.21) e **FFmpeg** (`ffprobe` e `ffmpeg` no PATH — no Windows: `winget install Gyan.FFmpeg`).

```bash
npm install                      # instala backend e frontend (workspaces)
cp .env.example .env             # depois edite o .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#   ↑ cole o resultado em TOKEN_ENCRYPTION_KEY (necessário para conectar contas reais)
```

| Comando | O que faz |
|---|---|
| `npm run dev` | Backend (http://localhost:3001, recarrega ao salvar) + interface Vite (http://localhost:5173) |
| `npm test` | Testes do backend (51) e do frontend (3) — sem credenciais e sem rede |
| `npm run build` | Compila backend (`server/dist`) e interface (`web/dist`) |
| `npm run build:web` | Só a interface (é o comando usado pela Vercel) |
| `npm start` | Produção local: um único processo em http://localhost:3001 servindo API **e** interface |
| `npm run typecheck` | Verificação de tipos (backend, interface e Function de proxy) |

Em produção (`npm start`), ajuste `WEB_ORIGIN=http://localhost:3001` no `.env`.

### Rodar o backend continuamente

A fila roda no backend, então ele precisa ficar ligado para as ações que dependem do Node (veja a seção 5). Opções no Windows:

```bash
npm run build
npm install -g pm2 pm2-windows-startup
pm2 start server/dist/index.js --name agendador
pm2 save && pm2-startup install     # volta sozinho depois de reiniciar o Windows
pm2 logs agendador                  # acompanhar
```

Alternativas: serviço com [NSSM](https://nssm.cc/) (`nssm install agendador "C:\Program Files\nodejs\node.exe" server\dist\index.js`) ou o Agendador de Tarefas ("ao fazer logon"). Desative a suspensão do computador nos horários de publicação. Em Linux/macOS, use `pm2` ou um serviço `systemd`/`launchd`.

---

## 2. Versão hospedada: Vercel + backend persistente

### Por que a fila não roda inteira na Vercel

Limites consultados na documentação da Vercel em 14/11/2026:

| Limite da Vercel | Impacto neste app |
|---|---|
| Corpo de requisição/resposta de Function: **4,5 MB** | Vídeos (até `MAX_VIDEO_MB`, padrão 1 GB) não passam por uma Function |
| Rewrite para origem externa: **timeout de 120 s** | Upload de vídeo por proxy também não serve |
| Duração de Function: **300 s** (Hobby) / até 800 s (Pro) | Enviar vídeos grandes ao YouTube/Meta numa única execução é arriscado |
| Disco: somente `/tmp` (500 MB), sem persistência garantida | `DATA_DIR`, mídia e a fila em JSON não sobrevivem entre execuções |
| Cron no **Hobby: 1×/dia, com variação de até 59 min**; no Pro, por minuto | No Hobby é impossível publicar o Instagram às 12:00 ou abrir a janela de 29 dias do Facebook na hora certa |
| Sem processo permanente e sem `ffprobe` | Os timers da fila (`setInterval`) e a validação de mídia precisam de um Node ligado |

Levar a fila inteira para a nuvem exigiria plano **Pro**, armazenamento de objetos (por exemplo, Vercel Blob com upload direto do navegador), um banco para lotes, tarefas, idempotência e tokens no lugar dos arquivos JSON, envio aos provedores em etapas retomáveis entre execuções e uma alternativa ao `ffprobe`. Isso é uma reescrita da camada de persistência e da fila, além de custos novos. Por isso o projeto adota a **arquitetura híbrida**, sem banco novo:

```
Navegador ──► Vercel: interface (web/dist) + /termos + /privacidade
   │            └─ /api/* ──► Function api/proxy.ts ──► BACKEND_URL/api/*  (JSON, com o segredo do proxy)
   │
   └──── vídeos e capas (PUT) / prévias (GET) ──► BACKEND /direct/* (links assinados e temporários)

Backend Node persistente (seu PC + túnel HTTPS com nome fixo, ou uma VPS):
   fila (worker), data/ (lotes, tarefas, mídia, tokens cifrados), ffprobe,
   callbacks OAuth (/api/oauth/*/callback), links para a Meta (/public/media/*)
```

**O que continua dependendo do servidor Node**: a fila inteira (envios, agendamentos nativos, Instagram às 12:00, janela de 29 dias do Facebook, confirmação de "Publicado", reconciliação após reinício), o armazenamento de vídeos, capas e tokens, a validação com `ffprobe`, os callbacks OAuth e os links temporários usados pela Meta. Sem o backend ligado, a interface na Vercel abre (inclusive `/`, `/termos` e `/privacidade`), mas as telas mostram "Não foi possível falar com o backend".

### Segurança da versão hospedada

- **Sem login**: a interface hospedada abre direto, sem senha nem cookie de sessão. **Qualquer pessoa que souber o endereço da Vercel consegue usar o app**, inclusive conectar contas, enviar vídeos, agendar e cancelar publicações. Não divulgue o endereço. Se precisar restringir o acesso, use a proteção de implantação da própria Vercel (Deployment Protection), mas ela também bloqueia `/termos` e `/privacidade` para os revisores do TikTok.
- **Backend exposto pelo túnel**: só aceita `/api/*` com o cabeçalho `x-agendador-proxy` igual a `BACKEND_PROXY_SECRET` (colocado pela Function). Escrita de outras origens é recusada (`Origin` precisa ser `APP_URL`). Abertos sem o segredo: `/api/oauth/*/callback` (protegido por `state` de uso único) e `/direct/*` e `/public/media/*` (tokens HMAC por arquivo e com validade). O resto responde `403`.
- **Uploads e mídia**: o backend devolve à interface links `PUBLIC_BASE_URL/direct/upload/<token>` (validade de 3 h, um link por vídeo/capa) e `/direct/media/<token>` (6 h). O CORS fica liberado só para `APP_URL`. Os vídeos não passam pela Vercel.
- **Segredos**: tokens OAuth, client secrets e `TOKEN_ENCRYPTION_KEY` (que criptografa os tokens das redes) ficam **só no backend**. Na Vercel ficam apenas `BACKEND_URL` e `BACKEND_PROXY_SECRET`, sem prefixo `VITE_`, lidas só pela Function. O bundle não contém segredos nem `localhost`.
- **Uso local**: pedidos de `localhost` funcionam como antes.

### Passo a passo

1. **Backend com HTTPS fixo.** Use um túnel com nome estável (por exemplo, Cloudflare Tunnel com domínio próprio, `cloudflared tunnel run`) apontando para `http://localhost:3001`, ou uma VPS com proxy HTTPS. Túneis "rápidos" mudam de endereço a cada execução e quebram os callbacks cadastrados.
2. No `.env` do backend, defina `PUBLIC_BASE_URL` (endereço HTTPS do backend), `APP_URL` (endereço da Vercel), e `BACKEND_PROXY_SECRET`. Atualize também os callbacks (tabela da seção 7). Rode `npm run build && pm2 start server/dist/index.js --name agendador`.
3. **Vercel → Add New Project → importe `Wozdelta/agendador-junior`**:
   - **Framework Preset**: `Vite`
   - **Root Directory**: `./` (raiz do repositório — a interface importa `server/src/shared` e a Function fica em `api/`)
   - **Install Command**: `npm install` · **Build Command**: `npm run build:web` · **Output Directory**: `web/dist` (os três já estão no `vercel.json`)
   - **Environment Variables**: `BACKEND_URL` e `BACKEND_PROXY_SECRET`
4. Depois do primeiro deploy, coloque o domínio real em `APP_URL` no backend e reinicie-o.

### Rotas na Vercel

`vercel.json` reescreve `/api/*` para a Function `api/proxy.ts` e todo o resto para `index.html` (fallback de SPA, que garante link direto e recarregar em `/termos`, `/privacidade` e `/`). Arquivos estáticos de `web/dist` (incluindo os de `web/public`) têm precedência sobre os rewrites.

### Endereços para o portal do TikTok

| Campo | Valor |
|---|---|
| Website URL | `https://DOMINIO-REAL-DA-VERCEL/` |
| Terms of Service URL | `https://DOMINIO-REAL-DA-VERCEL/termos` |
| Privacy Policy URL | `https://DOMINIO-REAL-DA-VERCEL/privacidade` |
| Redirect URI (Login Kit) | `https://DOMINIO-DO-BACKEND/api/oauth/tiktok/callback` (o callback é atendido pelo **backend**, não pela Vercel) |

Antes de enviar, preencha os campos marcados como **[PREENCHER]** em `web/src/legal/config.ts`: responsável, e-mail de contato, local do backend, política de retenção e foro. Enquanto estiverem vazios, as páginas mostram um aviso de rascunho.

**Arquivo de verificação do TikTok.** Se o portal pedir para verificar um domínio ou prefixo de URL por arquivo, baixe o arquivo que ele gerar e coloque-o em `web/public/` **mantendo o nome exato e o caminho pedido**. Por exemplo, `https://DOMINIO/tiktokABC123.txt` vira `web/public/tiktokABC123.txt`, e um prefixo como `https://DOMINIO/verificacao/` vira `web/public/verificacao/<arquivo>`. O Vite copia `web/public` para a raiz do build e a Vercel serve esse arquivo antes do fallback de SPA. Confira abrindo a URL no navegador depois do deploy. Em um domínio `*.vercel.app` não dá para criar registro DNS, então use o método de arquivo ou um domínio próprio. Este app envia vídeos ao TikTok por `FILE_UPLOAD` e por isso não precisa verificar o domínio do backend para mídia (isso só é exigido para `PULL_FROM_URL`).

**Modo pessoal do TikTok**: mantenha `TIKTOK_VIDEO_UPLOAD_APPROVED=false` e `TIKTOK_DIRECT_POST_APPROVED=false`. A agenda mostra "Ação manual necessária" com a descrição para copiar e o vídeo para baixar.

---

## 3. Modo demonstração × modo real

- O aplicativo inicia no **modo real**. O **modo demonstração** só é ativado por **Configurações → Ativar modo demonstração**, com confirmação explícita.
- Com a demonstração ativa, uma faixa laranja **"MODO DEMONSTRAÇÃO"** fica fixa no topo, as contas aparecem como `[DEMO] …` e cada tarefa leva o selo **DEMO**.
- Isolamento: os dados ficam em `data/demo/` × `data/real/` (lotes, fila, mídia, conexões). Os conectores simulados não acessam a rede, e os reais nunca processam tarefas de demonstração.
- Na demonstração, **Configurações → Simular falhas** programa uma falha (definitiva, temporária, timeout após envio ou resultado desconhecido) para testar a recuperação.
- No modo real, o **TikTok manual funciona sem nenhuma credencial**. Facebook, Instagram e YouTube exigem as conexões da seção 7.

---

## 4. Como usar

1. **Novo lote** → digite a **Data inicial** (`DD/MM/AAAA`) ou use o calendário. Datas inválidas ou passadas mostram erro no campo.
2. Com a data válida, aparece a área para **arrastar e soltar** vários vídeos ou o botão **Selecionar vídeos**. A ordem recebida pelo navegador vira a ordem inicial: um vídeo por dia corrido (fins de semana e feriados incluídos), sempre às 12:00.
3. Cada vídeo mostra a prévia, a data, a duração, a resolução, o progresso de upload e uma aba por rede (**Facebook**: título e descrição; **YouTube**: título, descrição e "feito para crianças?" obrigatório; **Instagram**: legenda; **TikTok**: descrição). Os contadores seguem os limites oficiais, e é possível desligar uma rede só naquele vídeo.
4. Para reorganizar, arraste o cabeçalho do cartão ou use **Subir**/**Descer**. Ao reordenar, excluir ou mudar a data inicial, o **servidor** recalcula as datas, e textos e capa continuam no mesmo vídeo.
5. **Capa do vídeo** (opcional): envie uma imagem JPEG/PNG e escolha um **quadro** para as conexões que só aceitam quadro. O cartão mostra o resultado por rede.
6. Tudo é salvo automaticamente **no servidor**: dá para fechar a aba e continuar depois (os rascunhos aparecem em "Rascunhos salvos").
7. **Revisar e agendar** mostra o resumo com vídeos, datas, contas, plataformas e avisos. **Confirmar agendamento** registra uma tarefa por **vídeo + plataforma + conta**.
8. **Agenda**: estados, hora planejada × efetiva, tentativas, erros, capa, link remoto, histórico e as ações permitidas em cada estado.

### Estados da agenda

| Estado | Quando |
|---|---|
| **Rascunho** | Vídeo em lote ainda não confirmado |
| **Na fila do aplicativo** | Aguardando a hora de agir (ou a janela de agendamento nativo) |
| **Em processamento** | Enviando ou aguardando processamento na plataforma |
| **Agendado na plataforma** | **Só depois da confirmação do fornecedor** (consulta pelo ID remoto) |
| **Publicado** | Confirmação remota, **ou** registro manual (aparece como "Publicado (registro manual)") |
| **Ação manual necessária** | TikTok manual; "Enviado ao TikTok" (caixa de entrada — ainda **não** publicado); ou "Revisar na plataforma" (resultado desconhecido) |
| **Atrasado** | Passou da tolerância (`LATE_TOLERANCE_MINUTES`) sem publicar; escolha uma nova data |
| **Falha** | Erro definitivo ou tentativas esgotadas; "Tentar novamente" retoma **só aquele item** |
| **Cancelado** | Cancelado pelo usuário (para agendamento nativo, só depois de a plataforma confirmar) |

---

## 5. O que depende do Node ligado

| Plataforma | Mecanismo | Depende do backend ligado? |
|---|---|---|
| **YouTube** | Upload imediato com `privacyStatus=private` + `publishAt` (agendamento **nativo**) | Só para enviar e aplicar a capa. Depois de "Agendado na plataforma", o YouTube publica sozinho. A confirmação de "Publicado" acontece quando o Node voltar. |
| **Facebook** | `video_reels` com `video_state=SCHEDULED` (nativo) | Para enviar. Datas a **mais de 29 dias** ficam na fila do app até a janela abrir, e o Node precisa estar ligado nesse dia. Com o fallback de publicação direta, também precisa estar ligado ao meio-dia. |
| **Instagram** | Sem agendamento nativo na API: container ~60 min antes e `media_publish` às 12:00 | **Sim**: às 11:00 (container) e às 12:00 (publicação). |
| **TikTok manual** | Lembrete na agenda | Não (a ação é sua). |
| **TikTok caixa de entrada / Direct Post** | Envio ~30 min antes (caixa de entrada) ou no horário (Direct Post) | **Sim**. |

**Como identificar um agendamento nativo confirmado:** na Agenda, o estado é **Agendado na plataforma** e aparece a etiqueta **"agendamento nativo · ID …"**. O histórico registra a confirmação, por exemplo *"Agendamento nativo confirmado pelo YouTube para 2026-11-15T15:00:00.000Z"* ou *"…pela Meta (publish_status=scheduled)"*. Para conferir na plataforma: YouTube Studio → Conteúdo → visibilidade "Programado"; Meta Business Suite → Planejador / Conteúdo → Programado.

---

## 6. Fila, recuperação e segurança

**Fila persistente** (`server/src/queue/worker.ts`)
- Cada tarefa grava estado, etapa interna, IDs remotos (sessão de upload, `video_id`, container, `publish_id`), tentativas, próximo horário e erro resumido em `data/<modo>/tasks.json`.
- Concorrência: até `WORKER_CONCURRENCY` tarefas ao mesmo tempo, uma por plataforma, e trava por tarefa compartilhada com as ações da Agenda.
- Na inicialização, tarefas travadas por um processo anterior são **reconciliadas pelo ID remoto** antes de qualquer reenvio: o YouTube consulta a sessão retomável, a Meta consulta o status do vídeo ou do container, o TikTok consulta o `publish_id`.
- Timeout depois de um pedido que pode ter criado algo (upload final, `finish`, `media_publish`): o item é marcado para reconciliação, o resultado remoto é consultado antes de repetir e, se continuar desconhecido, vira **"Revisar na plataforma"**.
- Novas tentativas com espera exponencial e limitada (`MAX_ATTEMPTS`), respeitando `Retry-After`. **Cota do projeto Google**: espera a renovação (meia-noite do Pacífico) sem gastar tentativas. **Limite de envios do canal** (`uploadLimitExceeded`): mensagem própria. **Meta**: códigos 4/17/32/613 e limite de 30 Reels/24 h por Página. **Instagram**: consulta `content_publishing_limit` antes de criar e de publicar. **TikTok**: máximo de 5 envios pendentes em 24 h.
- Autorização expirada: a tarefa falha com "Reconecte…" e a conexão aparece como **Reconectar**.

**Idempotência**: as ações de escrita aceitam o cabeçalho `Idempotency-Key`, e a interface gera uma chave por ação. O mesmo pedido repetido (clique duplo) recebe a mesma resposta, e um pedido ainda em andamento recebe `409`. A confirmação do lote usa IDs determinísticos de tarefa (lote + vídeo + plataforma + conta) e a trava do lote, então duas confirmações nunca duplicam tarefas.

**Dados e mídia**
- Gravação atômica (arquivo temporário + `fsync` + `rename`) e alterações serializadas por mutex.
- Upload por **streaming** direto para o disco (busboy), com limite de tamanho durante o envio, tipo real verificado pelos primeiros bytes (MP4/MOV, JPEG/PNG) e `ffprobe` para duração, resolução (considerando a rotação), proporção e codec. O nome interno é gerado (UUID), e o nome original nunca vira caminho.

**Credenciais**
- Tokens e refresh tokens ficam **só no servidor**, criptografados com **AES-256-GCM** (IV aleatório + AAD por plataforma) em `data/real/connections.json`. A chave vem de `TOKEN_ENCRYPTION_KEY`, fora do repositório: use uma variável de ambiente do serviço ou um cofre do sistema.
- O frontend recebe apenas o nome da conta, o estado da conexão e as capacidades. Nada vai para `localStorage`, `sessionStorage`, IndexedDB ou o bundle. Os logs mascaram tokens.
- OAuth com `state` de uso único (validade de 10 min) e **PKCE** no Google. Meta e TikTok Web usam `state`; a documentação do TikTok exige `code_verifier` só para apps desktop e mobile.
- `Cache-Control: no-store` em todas as rotas `/api`, bloqueio de escrita vinda de outras origens e servidor ligado em `127.0.0.1`.
- **Acesso externo** (túnel HTTPS em `PUBLIC_BASE_URL`): pedidos que chegam pelo host público ou com `X-Forwarded-For` só alcançam `GET /public/media/<token>/<arquivo>` (link HMAC com validade de `MEDIA_LINK_TTL_MINUTES`, válido para um único arquivo) e `GET /api/oauth/<plataforma>/callback`. Todo o resto responde `403`.

---

## 7. Configuração das plataformas

Os callbacks OAuth são atendidos **pelo backend** (rotas reais `GET /api/oauth/<plataforma>/callback`), nunca pela Vercel. Cadastre nos consoles o endereço do lugar onde o backend atende e coloque o mesmo valor no `.env`:

| Plataforma | Variável | Uso local | Versão hospedada (backend público) |
|---|---|---|---|
| YouTube | `GOOGLE_REDIRECT_URI` | `http://localhost:3001/api/oauth/youtube/callback` | `https://DOMINIO-DO-BACKEND/api/oauth/youtube/callback` |
| Facebook/Instagram | `META_REDIRECT_URI` | `http://localhost:3001/api/oauth/facebook/callback` | `https://DOMINIO-DO-BACKEND/api/oauth/facebook/callback` |
| TikTok | `TIKTOK_REDIRECT_URI` | — (exige HTTPS) | `https://DOMINIO-DO-BACKEND/api/oauth/tiktok/callback` |

Dá para cadastrar as duas URLs (local e hospedada) no Google e na Meta; o `.env` escolhe qual é usada. Depois de autorizar, o backend devolve o navegador para `APP_URL/#/conexoes` (ou para `localhost` no uso local). `DOMINIO-DO-BACKEND` é o host de `PUBLIC_BASE_URL` (túnel com nome fixo ou VPS).

### 7.1 Google Cloud (YouTube Shorts)

1. Em https://console.cloud.google.com crie um projeto e ative a **YouTube Data API v3** (APIs e serviços → Biblioteca).
2. **Tela de consentimento OAuth** (Google Auth Platform): tipo **Externo**; adicione sua conta Google em **Usuários de teste**.
3. **Acesso a dados / escopos**: `https://www.googleapis.com/auth/youtube.upload` e `https://www.googleapis.com/auth/youtube` (o segundo serve para confirmar, alterar e cancelar agendamentos).
4. **Credenciais → Criar ID do cliente OAuth → Aplicativo da Web**. URI de redirecionamento autorizado: o callback do YouTube acima. Copie o ID e a chave secreta para `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.
5. No app: **Conexões → YouTube → Conectar**. A tela mostra o **canal autorizado**. O app pede acesso offline (`access_type=offline`, `prompt=consent`) com PKCE.
6. **Expiração em modo de teste**: com a tela de consentimento **Externa** em status **"Testing"**, o Google emite refresh tokens que **expiram em 7 dias**. Nesse caso a conexão aparece como **Reconectar** e as tarefas falham com aviso. Para evitar isso, publique o app ("In production"); escopos sensíveis do YouTube podem exigir verificação do Google. Refresh tokens também expiram após 6 meses sem uso, por revogação ou pelo limite de tokens por cliente.
7. **Cota**: o padrão é 10.000 unidades/dia por projeto. A revisão de 04/12/2025 moveu `videos.insert` para um "bucket" próprio de uploads (≈100 unidades); `thumbnails.set` custa ≈50. Confira na calculadora de cota do console.
8. **Capas personalizadas**: o canal precisa ter recursos intermediários liberados (verificação por telefone em youtube.com/verify). Desde **03/11/2026**, `thumbnails.set` aceita Shorts depois do processamento (até **50 MB**, JPEG/PNG). Se o envio da capa falhar, a Agenda informa separadamente que o vídeo foi enviado e agendado e que a capa precisa de atenção.
9. **Elegibilidade a Short**: vídeo **vertical ou quadrado** de até **3 minutos** (canais padrão, desde 15/10/2024). O app valida isso antes do upload.

### 7.2 Meta for Developers (Facebook Reels e Instagram Reels)

Contas exigidas: uma **Página do Facebook** em que você possa criar conteúdo (tarefa `CREATE_CONTENT`/`MANAGE`) e, para o Instagram, uma **conta profissional** (Empresa ou Criador) **vinculada a essa Página**. Se a Página exigir *Page Publishing Authorization (PPA)*, conclua essa etapa antes.

1. Em https://developers.facebook.com → **Meus apps → Criar app**, escolha o tipo **Business** (ou os casos de uso "Gerenciar tudo na sua Página" e "Gerenciar mensagens e conteúdo no Instagram").
2. Adicione **Facebook Login for Business** (ou Facebook Login). Em **URIs de redirecionamento OAuth válidos**, cadastre o callback do Facebook acima (o `localhost` é aceito com o app em modo de desenvolvimento).
3. **Permissões** que o app solicita: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` e `business_management` (para Páginas do Gerenciador de Negócios). Com Facebook Login for Business, crie uma **configuração** com essas permissões e coloque o ID em `META_LOGIN_CONFIG_ID`.
4. Copie o ID e a chave secreta do app para `META_APP_ID` e `META_APP_SECRET`. A versão da API fica em `META_GRAPH_VERSION` (padrão `v27.0`).
5. **Revisão**: para uso pessoal, com o app em **modo de desenvolvimento** e você como administrador do app, as permissões funcionam **sem App Review**. Para outras pessoas usarem, é preciso Acesso Avançado + App Review de cada permissão + verificação da empresa.
6. No app: **Conexões → Facebook → Conectar** e escolha a **Página de destino**. O app troca o token por um de longa duração, obtém o **token da Página** e mostra se há Instagram profissional vinculado.
7. **Instagram: como a Meta recebe o vídeo**
   - Padrão: `video_url`. Configure `PUBLIC_BASE_URL` (túnel HTTPS). O app gera um link temporário assinado só para aquele arquivo.
   - Ou `IG_RESUMABLE_UPLOAD=true` (upload retomável para `rupload.facebook.com`), que a documentação restringe a apps com **Facebook Login for Business**.
   - Capa do Instagram: `cover_url` (link temporário da imagem convertida para JPEG) quando há `PUBLIC_BASE_URL`; caso contrário, `thumb_offset` com o quadro escolhido, e a imagem fica disponível para uso manual.
8. **Facebook Reels**: o agendamento nativo vale para horários entre **10 minutos e 29 dias** à frente. Datas mais distantes ficam **Na fila do aplicativo** até entrar na janela. Se a Página recusar o agendamento nativo, ative `META_ALLOW_DIRECT_PUBLISH_FALLBACK=true` para o app publicar no horário (precisa do Node ligado). A **capa personalizada de Reels** fica desligada por padrão (`META_REELS_CUSTOM_COVER=false`), porque a documentação não confirma explicitamente o `/{video-id}/thumbnails` para Reels. Ative só depois de testar na sua Página.
9. **Limites**: Reels: 30 publicados via API por Página em 24 h (regra do endpoint de Reels, diferente da regra do feed da Página). Instagram: o app consulta `content_publishing_limit` (a documentação cita 100 posts/24 h em um trecho e 50 em outro, então o valor real vem da API); 400 containers por 24 h; o container expira em 24 h.

### 7.3 TikTok for Developers

**Versão pessoal (padrão, sem credenciais):** no horário, a Agenda mostra **Ação manual necessária** com **Copiar descrição**, **Baixar vídeo original** (e a capa, se houver) e **Registrar publicação** (com link opcional).

Para automatizar:
1. Em https://developers.tiktok.com crie um app e adicione **Login Kit (Web)** e **Content Posting API**.
2. Cadastre o **Redirect URI HTTPS** (`https://SEU-TUNEL/api/oauth/tiktok/callback`) e preencha `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` e `TIKTOK_REDIRECT_URI`.
3. Escopos: `user.info.basic` + **`video.upload`** (envio à caixa de entrada). Envie o app para revisão. **Só depois da aprovação** defina `TIKTOK_VIDEO_UPLOAD_APPROVED=true` e conecte em **Conexões → TikTok**. O vídeo vai para a caixa de entrada ~30 min antes (`TIKTOK_INBOX_LEAD_MINUTES`) e a Agenda mostra **"Ação manual necessária · Enviado ao TikTok"**, que **não** é "Publicado". Você finaliza no app do TikTok (a descrição continua disponível para copiar) e registra a conclusão, ou o app marca "Publicado" se o TikTok informar `PUBLISH_COMPLETE`. Limite: 5 envios pendentes em 24 h.
4. **Direct Post** (`video.publish`): só para casos de uso elegíveis, com **auditoria** aprovada. Antes dela, todo conteúdo fica restrito a privado (`SELF_ONLY`). Depois da aprovação, defina `TIKTOK_DIRECT_POST_APPROVED=true`. O app consulta `creator_info`, mostra as opções de privacidade reais da conta, exige o consentimento em cada vídeo e usa `video_cover_timestamp_ms` com o quadro escolhido.
5. Tokens: o access token dura 2 h e o refresh token 180 dias (rotativo). O app renova automaticamente.

---

## 8. Rotas da API

Todas sob `/api` do backend (`http://localhost:3001/api` localmente; pela Vercel, `https://DOMINIO-DA-VERCEL/api/*` via proxy). Respostas JSON com `Cache-Control: no-store`. As rotas marcadas com **(I)** aceitam `Idempotency-Key`.

| Método e rota | Descrição |
|---|---|
| `GET /health` | Estado do backend e modo |
| `GET /settings` · `POST /settings/mode` `{mode, confirm:true}` | Parâmetros (inclui `remoteAccess` e `directLinks`) e troca explícita de modo |
| `POST /demo/faults` `{platform, kind, times}` | Simular falhas (só no modo demonstração) |
| `GET /batches?status=draft` | Rascunhos |
| `POST /batches` `{startDate:"DD/MM/AAAA"}` **(I)** | Cria rascunho (valida data futura) |
| `GET /batches/:id` · `PATCH /batches/:id` `{startDate?, platforms?}` · `DELETE /batches/:id` | Lê, altera (recalcula datas) e descarta |
| `POST /batches/:id/items` `{files:[{name,size}]}` | Reserva os vídeos na ordem do navegador |
| `PUT /batches/:id/items/:itemId/video` (multipart `file`) | Upload por streaming + `ffprobe` |
| `PATCH /batches/:id/items/:itemId` `{platforms:{facebook:{title,description,enabled},…}, coverFrameMs}` | Textos por plataforma e quadro da capa |
| `DELETE /batches/:id/items/:itemId` | Remove o vídeo e recalcula as datas |
| `PUT /batches/:id/order` `{itemIds:[…]}` | Reordena e recalcula as datas |
| `PUT /batches/:id/items/:itemId/cover` (multipart) · `DELETE …/cover` | Capa do vídeo |
| `GET /batches/:id/summary` | Resumo, pendências e avisos |
| `POST /batches/:id/confirm` **(I)** | Valida no servidor e registra as tarefas |
| `GET /tasks` | Agenda (tarefas + itens em rascunho) |
| `PATCH /tasks/:id` `{title, description}` **(I)** | Editar (confirma com a plataforma se for agendamento nativo) |
| `POST /tasks/:id/cancel` **(I)** | Cancelar (confirma com a plataforma antes) |
| `POST /tasks/:id/retry` **(I)** | Nova tentativa só deste item |
| `POST /tasks/:id/reschedule` `{date, time?}` **(I)** | Nova data |
| `POST /tasks/:id/manual-complete` `{url?}` **(I)** | Registro manual de publicação |
| `POST /tasks/:id/resolve-review` `{outcome:"published"\|"not_published", url?}` **(I)** | Resolve resultado desconhecido |
| `GET /media/:id[?download=1]` | Vídeo/capa para prévia ou download (somente localhost) |
| `GET /connections` | Estado das conexões (sem tokens) |
| `GET /connections/:platform/start` | Inicia o OAuth (`youtube`, `facebook`, `tiktok`) |
| `GET /oauth/:platform/callback` | Retorno OAuth (valida `state`; PKCE no Google) |
| `POST /connections/facebook/page` `{pageId}` | Escolhe a Página (e o Instagram vinculado) |
| `POST /connections/:platform/disconnect` | Apaga os tokens |
| `GET /connections/tiktok/creator-info` | Opções reais da conta (Direct Post) |
| `GET /public/media/:token/:arquivo` (fora de `/api`) | Link temporário assinado para a Meta baixar um arquivo |
| `PUT /direct/upload/:token` (fora de `/api`, multipart `file`) | Upload direto do navegador ao backend (versão hospedada; CORS só para `APP_URL`) |
| `GET /direct/media/:token[?download=1]` (fora de `/api`) | Prévia/download por link assinado (versão hospedada) |

---

## 9. Verificação

Executado em 14/11/2026, no Windows 11, Node 24.21 e FFmpeg local:

- `npm test` → **backend: 51 testes passando**, **frontend: 3 passando**. Os testes geram vídeos reais com o `ffmpeg` e usam **datas futuras calculadas a partir do relógio real**. Um relógio de teste só avança a fila.
- `npm run build`, `npm start` e `npm run dev` foram executados. O fluxo também foi exercitado ao vivo por HTTP contra o servidor compilado.
- **Versão hospedada** (`remote.test.ts`, sem Vercel real e sem provedores): interface acessa a API direto pelo proxy, sem senha nem cookie; rotas `/api/auth/*` removidas (404); bloqueio de `/api` sem o segredo do proxy ou com segredo errado; escrita de outra origem recusada; uso local; **lote de 5 vídeos montado pelo proxy** com uploads em links assinados (datas consecutivas às 12:00); CORS e links adulterados ou vencidos; início do OAuth (Google com `state`/PKCE/`access_type=offline` e callback HTTPS do backend; Meta v27.0 com escopos; TikTok sem configuração → erro claro); callback com `state` forjado, cancelamento e reuso de `state`. A **Function `api/proxy.ts` foi executada contra o backend real**, incluindo o `302` do OAuth e o `503` sem `BACKEND_URL`.
- `npm run build:web` (comando da Vercel) foi testado com `vite preview`: `/`, `/termos`, `/privacidade` e rotas desconhecidas respondem `200` (fallback SPA) e o `favicon.svg` é servido como arquivo estático. As páginas legais foram renderizadas para conferir texto, rodapé e marcadores [PREENCHER]. **O deploy na Vercel não foi executado.**

| Fluxo pedido | Resultado | Onde |
|---|---|---|
| Um vídeo (12:00 SP, gravado em UTC) | ✅ | `flow.test.ts` |
| Cinco vídeos em dias consecutivos ao meio-dia | ✅ (ao vivo: 15/11/2026 → 19/11/2026, 12:00, `15:00Z`) | `time.test.ts`, `flow.test.ts`, teste ao vivo |
| Reordenação (datas recalculadas; textos e capa seguem o vídeo) | ✅ | `flow.test.ts` |
| Datas passadas / inválidas / rascunho que venceu | ✅ erro no formulário e confirmação recusada no servidor | `flow.test.ts`, teste ao vivo |
| Fechamento da aba (rascunho persiste no servidor) | ✅ | `flow.test.ts` |
| Reinício do backend no meio de um envio | ✅ reconcilia pelo ID remoto, sem duplicar | `flow.test.ts`, `adapters.test.ts` (YouTube) |
| Clique duplo | ✅ mesma chave: 1 execução; chaves diferentes: sem tarefas duplicadas (ao vivo: `201` + `409`, 20 tarefas) | `flow.test.ts`, teste ao vivo |
| Falha em uma plataforma, sucesso nas demais, nova tentativa só dela | ✅ | `flow.test.ts` |
| TikTok manual (copiar, baixar, registrar com link) | ✅ | `flow.test.ts`, teste ao vivo |
| Atraso → "Atrasado" → nova data | ✅ | `flow.test.ts`, `adapters.test.ts` (Instagram processando ao meio-dia) |
| Resultado desconhecido → revisão manual | ✅ | `flow.test.ts`, `adapters.test.ts` (Instagram `media_publish`) |

**Conectores reais testados contra respostas simuladas** (`adapters.test.ts`, sem rede): YouTube (sessão retomável, `publishAt`, confirmação pelo ID, capa só após `succeeded`, cota do projeto × limite do canal, timeout sem reenvio, bloqueio de `publishAt` próximo/passado); Facebook (janela de 29 dias, `start`/`rupload`/`finish` com `SCHEDULED`, confirmação `publish_status=scheduled`, cancelamento via `DELETE`, erro 613); Instagram (container perto do horário, link temporário acessível só pelo túnel, `media_publish` às 12:00, timeout reconciliado); TikTok (caixa de entrada, `Content-Range`, renovação de token com rotação, tokens cifrados em disco).

**Não verificado com as APIs reais**: nenhuma integração foi chamada de verdade, porque não havia credenciais. Dependem da sua configuração ou aprovação:
- **YouTube**: projeto Google + OAuth (seção 7.1); capa exige canal com recursos intermediários.
- **Facebook / Instagram**: app Meta, Página com permissão de criação, Instagram profissional vinculado e `PUBLIC_BASE_URL` (ou Facebook Login for Business para o upload retomável). A capa de Reels no Facebook precisa ser confirmada na sua Página.
- **TikTok automático**: aprovação de `video.upload` (caixa de entrada) e auditoria de `video.publish` (Direct Post), além de túnel HTTPS para o callback.

---

## 10. Referências consultadas (14/11/2026)

| API | Versão | Páginas |
|---|---|---|
| YouTube Data API | **v3** (histórico de revisões até 03/11/2026) | [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [thumbnails.set](https://developers.google.com/youtube/v3/docs/thumbnails/set) · [Revision history](https://developers.google.com/youtube/v3/revision_history) · [Shorts até 3 min](https://support.google.com/youtube/answer/15424877) |
| Google OAuth 2.0 | — | [Using OAuth 2.0 / refresh token expiration](https://developers.google.com/identity/protocols/oauth2) |
| Meta Graph API (Facebook) | **v27.0** (exemplos da documentação) | [Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing) · [Page /video_reels](https://developers.facebook.com/docs/graph-api/reference/page/video_reels) · [Video thumbnails](https://developers.facebook.com/docs/graph-api/reference/video/thumbnails) · [Changelog](https://developers.facebook.com/docs/graph-api/changelog/versions) |
| Instagram API com Facebook Login | **v27.0** | [Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing) · [IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) · [Resumable uploads](https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads) · [content_publishing_limit](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit) |
| TikTok Content Posting API | **v2** | [Upload (inbox), atualizado 04/08/2026](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video) · [Direct Post, 27/10/2026](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) · [Creator Info, 27/10/2026](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info) · [Status, 04/08/2026](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status) · [Media Transfer, 04/08/2026](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide) |
| TikTok Login Kit | **v2** | [Login Kit Web, 04/08/2026](https://developers.tiktok.com/doc/login-kit-web) · [Tokens, 05/11/2026](https://developers.tiktok.com/doc/oauth-user-access-token-management) |

Pontos em que a documentação é ambígua e como o app trata cada um:
- **Limite do Instagram (100 × 50 por 24 h)**: o app usa o valor devolvido por `content_publishing_limit`.
- **Capa personalizada de Reels no Facebook não confirmada**: desligada por padrão.
- **Limites de título/descrição do Facebook não publicados**: o app usa limites conservadores (255 / 63.206).
- **Tipo de token do Instagram (Página × usuário)**: o app usa o token da Página.

---

## 11. Estrutura

```
server/src/
  config.ts, context.ts, app.ts, index.ts
  lib/        time (datas), store (JSON atômico), crypto (AES-GCM, links HMAC, PKCE), media (ffprobe), upload (streaming), http (Retry-After)
  domain/     batches (cálculo de datas, validação, resumo, confirmação), tasks (ações da agenda)
  platforms/  youtube, facebook, instagram, meta (OAuth/Graph), tiktok, demo (simulado), tokens
  queue/      worker (fila persistente, reconciliação, tentativas)
  routes/     batches, other (agenda, conexões, mídia, configurações), middleware (idempotência, origem, acesso externo)
  shared/     tipos e limites usados também pela interface
server/test/  time, limits, flow (fluxos completos no modo demo), adapters (conectores reais com fetch simulado), remote (versão hospedada e proxy)
web/src/      App (rotas públicas e app), components/ (NewBatch, VideoCard, DateField, Agenda, Connections, SettingsPage), legal/ (/termos, /privacidade e dados a preencher), lib/ (api, date)
api/          proxy.ts — Vercel Function que encaminha /api/* ao backend
vercel.json   build, saída e rewrites da Vercel
data/         criado em tempo de execução (fora do git): demo/ e real/
```
