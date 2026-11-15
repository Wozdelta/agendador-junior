# Redesign do Agendador Junior

Alterações locais de frontend. API, callbacks, variáveis de ambiente, configuração Vercel, chave e formato do armazenamento manual foram preservados. Não houve commit, push ou deploy.

## Abrir

- Aplicativo na prévia desta sessão: `http://127.0.0.1:5173/#/novo`.
- Prévia de quatro segundos: `http://127.0.0.1:5173/#/motion`.
- Para iniciar o projeto normalmente: `npm run dev`. A porta do Vite continua 5173; a API e os recursos disponíveis seguem a configuração existente.

A prévia desta sessão usa uma API isolada em 3002, sem worker, tokens ou publicações reais. Ela demonstra o fluxo manual da Vercel sem alterar dados do servidor ou contas existentes. O processo de prévia é temporário; não faz parte da produção.

## Barra Liquid Stretch

- Componente: `web/src/components/LiquidNav.tsx`.
- Motor compartilhado: `web/src/lib/liquid-motion.ts`.
- Palco/controles: `web/src/components/MotionPreview.tsx`.
- Quatro destinos reais, rota como fonte de verdade, `aria-current`, botões nativos e sincronização por `hashchange`.
- Duas molas analíticas: dianteira 19 / 0,55 e traseira 11 / 0,72. O retarget começa na posição e velocidade atuais; a geometria é limitada dentro da barra e nunca recebe largura negativa.
- A barra funcional para o RAF após o assentamento. ResizeObserver e listeners são limpos ao desmontar. Reflexos atualizam CSS, sem estado React por frame.
- A prévia usa um palco 470 × 240, barra 410 × 92 centrada em y=160, sequência 4 → 2 → 3 → 1 e ciclo de quatro segundos. São calculados ciclos anteriores para conservar a cauda da mola na virada. O toque também antecipa o evento do ciclo seguinte. Círculo e anel ficam ancorados na aba tocada; o anel mantém traço de 3 px e a sombra é aplicada ao preenchimento do círculo.
- “Interativo” interrompe o loop; clicar na barra da prévia também permite comparar os movimentos reais. A navegação do aplicativo nunca entra em loop automático.
- `prefers-reduced-motion`: posição final imediata, sem elasticidade, ripple expansivo ou deslocamento da página; controles continuam operantes.

A galeria pública [Tab Bar Part 4](https://ui-motion-prompts.pages.dev/p/tab_4.html) e sua imagem pública foram consultadas. O material completo está bloqueado por compra; nenhum prompt ou componente pago foi copiado. A implementação parte da especificação fornecida e usa React, CSS e SVG locais.

## Sistema visual e fluxos

- Inter variável servida pelo próprio projeto, com licença SIL OFL em `web/public/fonts/Inter-LICENSE.txt`.
- `web/src/design.css`: tema escuro, tipografia, vidro, botões, seleção, formulários, listas, páginas legais, estados e breakpoints.
- `web/src/layout-refinements.css`: ajustes de contraste, editor avançado, controles segmentados, mobile e movimento reduzido. `styles.css` permanece como base compatível do editor existente.
- `web/src/components/ui/Icon.tsx`: conjunto SVG e marca calendário/play; `GlassEffects.tsx`: reflexos e adaptação ao teclado; `useDialogFocus.ts`: foco inicial, ciclo de Tab e restauração ao fechar diálogos.
- Novo lote manual: data em português, seletor nativo acessível, arrastar arquivos, seleção múltipla, nomes longos, mover/remover, texto compartilhado, quatro checkboxes semânticos e prévia real por dia às 12:00. Erro ao gravar preserva os valores; sucesso só aparece após gravar no armazenamento existente.
- Agenda: lista por data, busca e filtros com estados vazios distintos, conclusão independente por rede, descrição editável, cópia, exclusão e exportação. Usa a chave e o schema anteriores do localStorage. O formulário de Novo lote permanece montado para conservar o que foi digitado ao trocar de seção.
- Editor com persistência/upload: mantém os dados por plataforma, validações, upload/progresso reais, rascunhos e reordenação. Recebe prévia lateral, seleção de redes e abas com indicador e navegação por setas, Home e End.
- Conexões: dados reais da API, estados determinados pelas capacidades, recuperação de erro, erros de ações próximos ao cartão, conta/Página vinculada, conexão/desconexão e publicação manual preservadas.
- Configurações: grupos de agenda, privacidade, modo e conexões. O switch representa apenas o modo existente, com os mesmos requisitos e confirmação; não inventa preferências ou salvamento.
- Termos e Privacidade: cabeçalho, rodapé e material visual renovados; conteúdo e URLs preservados. O `.txt` TikTok e o favicon existentes não foram editados.

## Verificado de fato

- Build do servidor e Vite e typecheck.
- **89 testes aprovados: 56 do servidor e 33 do frontend**, incluindo os novos testes de motor e eventos DOM com happy-dom.
- DOM: um e cinco arquivos, arrastar/recusar arquivo inválido, remover e reordenar nomes, alterar data sem remontar as linhas, selecionar plataformas, gravar e recuperar falha de armazenamento sem perder o formulário.
- DOM: filtros e busca, agenda vazia versus sem resultados, conclusão de uma plataforma mantendo as outras, JSON de exportação, conservação do formulário na troca de rota e recuperação de integração indisponível.
- DOM: aplicação dos breakpoints de CSS em 1440, 1024, 768, 390 e 320 px, quatro destinos presentes, barra inferior em telas pequenas e campos de 16 px no mobile. Isso verifica as regras, não equivale a medir o layout em um navegador real.
- Movimento: resposta das molas comparada à fórmula, limites da cápsula para várias larguras, salto de três abas, inversão de direção sem salto de posição/velocidade, doze segundos amostrados, continuidade 3,999s → 0s, sequência/antecipação do toque e ausência de ripple em movimento reduzido.
- HTTP: rotas do SPA, páginas públicas, fonte local e arquivo TikTok na prévia; integridade do `.txt` comparada com o build.

### Limites

O browser host de automação retornou **“The browser access host is unavailable”**. Não foi possível fazer inspeção visual por screenshot, medir sobreposição real/zoom, usar um teclado virtual físico ou observar o loop num navegador por dois ciclos. Esses itens permanecem para revisão visual no app aberto; não foram declarados como QA visual concluído.

`happy-dom` foi adicionado apenas como dependência de desenvolvimento para exercitar os eventos e estados sem o browser host. Não entra no bundle publicado. Nenhuma biblioteca de motion ou serviço externo foi adicionado. A auditoria consultada aponta avisos na cadeia preexistente de `@vercel/blob`; ela não foi atualizada à força nesta tarefa de frontend.

## Arquivos alterados

Existentes: `web/src/App.tsx`, `main.tsx`, `components/Agenda.tsx`, `Connections.tsx`, `DateField.tsx`, `ManualAgenda.tsx`, `NewBatch.tsx`, `SettingsPage.tsx`, `VideoCard.tsx`, `legal/LegalPages.tsx`, `web/package.json`, `package-lock.json`.

Novos: `web/src/components/LiquidNav.tsx`, `MotionPreview.tsx`, `ui/Icon.tsx`, `ui/GlassEffects.tsx`, `ui/useDialogFocus.ts`, `workspace.interactions.test.tsx`, `web/src/lib/liquid-motion.ts`, `liquid-motion.test.ts`, `web/src/design.css`, `layout-refinements.css`, `web/public/fonts/InterVariable.woff2`, `Inter-LICENSE.txt` e este documento.
