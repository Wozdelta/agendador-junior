import type { ReactNode } from 'react';
import { LEGAL, MISSING_FIELDS } from './config';
import { BrandMark, Icon } from '../components/ui/Icon';

/** Valor configurado ou marcador destacado para preencher antes de publicar. */
function Fill({ value, what }: { value: string | null; what: string }) {
  return value ? <>{value}</> : <mark className="fill">[PREENCHER: {what}]</mark>;
}

function Contact() {
  return LEGAL.contactEmail ? (
    <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
  ) : (
    <Fill value={null} what="e-mail de contato" />
  );
}

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <span className="footer-brand">
        <BrandMark />
        Agendador Junior<span className="brand-point">.</span>
      </span>
      <a href="/">Início</a>
      <a href="/termos">Termos de Uso</a>
      <a href="/privacidade">Política de Privacidade</a>
      <span className="muted">© {LEGAL.appName} · Espaço para suas ideias.</span>
    </footer>
  );
}

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="legal-page">
      <header className="legal-head">
        <a href="/" className="brand">
          <BrandMark /> {LEGAL.appName}
        </a>
        <a className="button" href="/#/novo">
          Voltar ao estúdio <Icon name="arrow" size={16} />
        </a>
      </header>
      <main className="legal">
        {MISSING_FIELDS.length > 0 && (
          <div className="alert demo" role="note">
            <strong>Rascunho:</strong> faltam dados a preencher em{' '}
            <code>web/src/legal/config.ts</code> antes de publicar: {MISSING_FIELDS.join(', ')}.
          </div>
        )}
        <h1>{title}</h1>
        <p className="muted">Última atualização: {LEGAL.lastUpdated}</p>
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}

export function TermsPage() {
  return (
    <LegalLayout title="Termos de Uso">
      <h2>1. O serviço</h2>
      <p>
        O {LEGAL.appName} é uma ferramenta para agendar, em lote, a publicação de vídeos curtos no
        Facebook Reels, YouTube Shorts, Instagram Reels e TikTok. Cada lote distribui um vídeo por
        dia corrido, às 12:00 no fuso America/Sao_Paulo, com título, descrição e situação separados
        por plataforma. O serviço é operado por{' '}
        <Fill value={LEGAL.operatorName} what="nome do responsável" />.
      </p>

      <h2>2. Acesso</h2>
      <p>
        O acesso ao painel exige e-mail e senha validados pelo Supabase Auth para a conta
        administradora configurada no servidor. Não há cadastro público. Termos, Privacidade e
        a verificação da plataforma continuam públicos.
      </p>

      <h2>3. Contas conectadas</h2>
      <p>
        As contas de cada plataforma são conectadas pelos fluxos oficiais de autorização (OAuth) do
        Google/YouTube, da Meta (Facebook e Instagram) e do TikTok. Ao conectar uma conta, você
        autoriza o app a enviar e agendar os vídeos que você escolher, nas datas mostradas na
        agenda, e continua sujeito aos termos de cada plataforma:
      </p>
      <ul>
        <li>
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
            Termos de Serviço do YouTube
          </a>{' '}
          (o app usa os Serviços de API do YouTube)
        </li>
        <li>
          <a href="https://www.facebook.com/terms" target="_blank" rel="noreferrer">
            Termos da Meta
          </a>{' '}
          e{' '}
          <a href="https://help.instagram.com/581066165581870" target="_blank" rel="noreferrer">
            Termos de Uso do Instagram
          </a>
        </li>
        <li>
          <a
            href="https://www.tiktok.com/legal/page/global/terms-of-service/pt-BR"
            target="_blank"
            rel="noreferrer"
          >
            Termos de Serviço do TikTok
          </a>
        </li>
      </ul>
      <p>
        Você pode desconectar qualquer conta a qualquer momento na tela "Conexões"; isso apaga os
        tokens guardados pelo app.
      </p>

      <h2>4. Seu conteúdo</h2>
      <p>
        Você é responsável pelos vídeos, capas, títulos e descrições que enviar e por ter os
        direitos necessários sobre eles. O app não altera o conteúdo do vídeo e só publica o que foi
        confirmado por você no resumo do lote.
      </p>

      <h2>5. TikTok</h2>
      <p>
        No modo pessoal, a publicação no TikTok é manual: no horário agendado, o app mostra "Ação
        manual necessária", com a descrição para copiar e o vídeo original para baixar, e você
        publica pelo app do TikTok e registra a conclusão. O envio à caixa de entrada do TikTok só é
        usado se essa permissão for aprovada para o app; nesse caso, você finaliza a publicação no
        app do TikTok. A publicação direta (Direct Post) fica desativada no modo pessoal.
      </p>

      <h2>6. Disponibilidade e limitações</h2>
      <p>
        A agenda manual registra um vídeo por dia às 12:00, mas a publicação depende da sua
        ação na plataforma. Agendamentos nativos de YouTube e Facebook só são assumidos pela rede
        após confirmação remota. A Vercel não executa um timer permanente: Instagram e TikTok
        permanecem manuais. O serviço depende da disponibilidade e das permissões de cada provedor.
      </p>

      <h2>7. Alterações e contato</h2>
      <p>
        Estes termos podem ser atualizados; a data acima indica a versão vigente. Dúvidas:{' '}
        <Contact />. Legislação aplicável:{' '}
        <Fill value={LEGAL.governingLaw} what="legislação/foro aplicável" />.
      </p>
      <p>
        Veja também a <a href="/privacidade">Política de Privacidade</a>.
      </p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Política de Privacidade">
      <h2>1. Responsável</h2>
      <p>
        Responsável pelo tratamento dos dados:{' '}
        <Fill value={LEGAL.operatorName} what="nome do responsável" />. Contato: <Contact />.
      </p>

      <h2>2. Dados que o app trata</h2>
      <ul>
        <li>
          <strong>Autorizações das plataformas:</strong> tokens de acesso e de atualização (OAuth)
          do YouTube, da Meta e do TikTok. Ficam somente no servidor do app, criptografados com
          AES-256-GCM, e nunca são enviados ao navegador.
        </li>
        <li>
          <strong>Dados das contas conectadas:</strong> nome e ID do canal do YouTube; nome e ID do
          usuário do Facebook, Páginas autorizadas e conta profissional do Instagram vinculada (ID e
          nome de usuário); no TikTok, o identificador (open_id) e o nome de exibição; e a lista de
          permissões concedidas.
        </li>
        <li>
          <strong>Conteúdo enviado:</strong> vídeos e imagens de capa, nome original dos arquivos e
          dados técnicos (duração, resolução, formato e tamanho), além dos títulos, descrições e
          opções escolhidas para cada plataforma.
        </li>
        <li>
          <strong>Agenda:</strong> datas e horários, situação de cada publicação, identificadores e
          links das publicações nas plataformas, tentativas, mensagens de erro e histórico.
        </li>
        <li>
          <strong>Acesso:</strong> e-mail e identidade confirmada pelo Supabase Auth, além de
          cookies essenciais HttpOnly para a sessão. Não usamos analytics ou publicidade.
          Os provedores podem registrar IP, data e hora das requisições.
        </li>
      </ul>

      <h2>3. Para que usamos</h2>
      <p>
        Exclusivamente para agendar e publicar os vídeos que você escolheu nas contas que você
        conectou, e para mostrar a situação de cada publicação. Não usamos os dados para
        publicidade, não vendemos dados e não os usamos para outros fins.
      </p>

      <h2>4. Com quem compartilhamos</h2>
      <p>
        O vídeo, a capa e os textos de cada publicação são enviados apenas à plataforma de destino
        (Google/YouTube, Meta/Facebook/Instagram ou TikTok) no momento do envio. Para o Instagram, a
        Meta baixa o arquivo por um link temporário e assinado, válido só para aquele arquivo. A
        interface e a API são hospedadas na Vercel. O Supabase processa autenticação e banco;
        o login usa e-mail e senha, sem envio de código. Na agenda manual guardamos apenas nomes
        e textos. No fluxo de upload real, arquivos vão diretamente para um bucket privado
        no Supabase Storage e são acessados por links temporários.
      </p>

      <h2>5. Onde e como os dados ficam</h2>
      <p>
        Os dados ficam no PostgreSQL do projeto Supabase escolhido pelo responsável. Tokens
        OAuth ficam criptografados com AES-256-GCM, acessíveis somente pelo backend após
        validação do administrador. A comunicação usa HTTPS. Registros antigos do navegador
        são importados somente por ação explícita e a cópia local é preservada.
      </p>

      <h2>6. Retenção</h2>
      <p>
        Hoje o app não apaga dados automaticamente. Os tokens ficam guardados até você desconectar a
        conta. Os vídeos de um rascunho são apagados quando o rascunho é descartado. Os vídeos,
        capas e histórico de lotes confirmados ficam guardados até serem removidos do servidor.
        Política definida: <Fill value={LEGAL.retentionPolicy} what="política de retenção" />.
      </p>

      <h2>7. Seus direitos e exclusão de dados</h2>
      <p>
        Você pode pedir acesso, correção ou exclusão dos seus dados (Lei nº 13.709/2018 — LGPD) pelo
        contato acima. Você também pode, a qualquer momento:
      </p>
      <ul>
        <li>desconectar a conta na tela "Conexões" do app (apaga os tokens guardados);</li>
        <li>
          revogar o acesso nas plataformas:{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            permissões da Conta Google
          </a>
          ,{' '}
          <a
            href="https://www.facebook.com/settings?tab=business_tools"
            target="_blank"
            rel="noreferrer"
          >
            integrações comerciais do Facebook
          </a>{' '}
          e, no TikTok, em Configurações e privacidade › Segurança › Gerenciar permissões de apps.
        </li>
      </ul>

      <h2>8. YouTube e Google</h2>
      <p>
        O app usa os Serviços de API do YouTube. Ao conectar o YouTube, você também está sujeito à{' '}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
          Política de Privacidade do Google
        </a>{' '}
        e aos{' '}
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
          Termos de Serviço do YouTube
        </a>
        .
      </p>

      <h2>9. Alterações</h2>
      <p>
        Esta política pode ser atualizada; a data acima indica a versão vigente. Veja também os{' '}
        <a href="/termos">Termos de Uso</a>.
      </p>
    </LegalLayout>
  );
}
