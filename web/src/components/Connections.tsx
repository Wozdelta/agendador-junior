import { useEffect, useState } from 'react';
import type { ConnectionDTO, Platform, SettingsDTO } from '../../../server/src/shared/types';
import { PLATFORM_LABEL, PLATFORMS } from '../../../server/src/shared/types';
import { api } from '../lib/api';
import { PLATFORM_HOME } from './ManualAgenda';
import { Icon } from './ui/Icon';
const CAP_LABEL: Record<string, string> = {
  native_schedule: 'Agendamento nativo',
  cover_image: 'Capa personalizada',
  cover_frame: 'Capa por quadro',
  queue: 'Fila de publicação',
  queue_fallback: 'Publicação direta',
  resumable: 'Upload retomável',
  manual: 'Publicação manual',
  inbox: 'Caixa de entrada',
  direct: 'Direct Post',
};
const LOGIN_LABEL: Record<Platform, string> = {
  youtube: 'Entrar com Google',
  facebook: 'Entrar com Facebook',
  instagram: 'Entrar com Facebook',
  tiktok: 'Entrar com TikTok',
};
export function Connections({ settings }: { settings: SettingsDTO }) {
  const [list, setList] = useState<ConnectionDTO[]>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [cardErrors, setCardErrors] = useState<Partial<Record<Platform, string>>>({}),
    [busy, setBusy] = useState<Platform | null>(null);
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const [flash] = useState(params.get('conectado')),
    [flashErr] = useState(params.get('erro'));
  const [origin] = useState(params.get('origem'));
  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setList(await api.connections());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const demo = settings.mode === 'demo';
  const meta = list.find(c => c.platform === 'facebook');
  const returnedPlatform = origin === 'instagram' ? 'instagram' : flash;
  const verifiedConnection = list.find(c => c.platform === returnedPlatform && c.connected && !c.needsReconnect);
  const connect = async (platform: Platform) => {
    setBusy(platform);
    setCardErrors(previous => ({...previous, [platform]:undefined}));
    try {
      const {url} = await api.startConnection(platform);
      window.location.assign(url);
    } catch (err:any) {
      setCardErrors(previous => ({...previous, [platform]:err.message}));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="connections-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SUAS REDES, NO MESMO LUGAR</span>
          <h1>
            Conexões<span className="accent-dot">.</span>
          </h1>
          <p>Entre nas suas redes e autorize o Agendador a conectar suas contas.</p>
        </div>
        <span className="context-badge">
          <Icon name="link" size={15} />
          {list.filter((c) => c.connected && !c.needsReconnect).length} de 4 conectadas
        </span>
      </div>
      {demo && (
        <div className="alert demo">Modo demonstração: contas e publicações são simuladas.</div>
      )}
      <div className="work-panel connection-login-guide">
        <strong>Conecte em três passos</strong>
        <p>Escolha uma rede, faça login na página oficial e permita o acesso. Depois, você volta para cá com a conta vinculada.</p>
        <p className="muted">Digite a senha da rede somente no site oficial. Para Instagram, entre pelo Facebook e selecione a Página vinculada ao perfil profissional.</p>
      </div>
      {flash && !loading && !error && !flashErr && verifiedConnection && (
        <div className="alert success" role="status">
          <Icon name="check" />
          Conta conectada: {PLATFORM_LABEL[verifiedConnection.platform]}{verifiedConnection.accountName ? ` · ${verifiedConnection.accountName}` : ''}.
        </div>
      )}
      {flash && !loading && !error && !flashErr && !verifiedConnection && (
        <div className="alert" role="status">
          {origin === 'instagram' && meta?.connected
            ? 'Facebook autorizado. Selecione abaixo a Página vinculada ao seu Instagram para concluir a conexão.'
            : 'A autorização retornou, mas a conta ainda não está pronta. Confira o cartão da rede e entre novamente se necessário.'}
        </div>
      )}
      {flashErr && (
        <div className="alert error" role="alert">
          <Icon name="info" />
          <span>{flashErr === 'cancelado' ? 'Você cancelou a autorização. Sua conexão anterior foi preservada; use Entrar novamente quando quiser.' : `A conexão não foi concluída: ${flashErr}. Tente conectar novamente.`}</span>
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          <Icon name="info" />
          <span>{error}</span>
          <button onClick={load}>Tentar de novo</button>
        </div>
      )}
      <div className="conn-grid">
        {loading && !list.length
          ? PLATFORMS.map((p) => (
              <section
                key={p}
                className="conn loading-connection"
                aria-label={`Carregando ${PLATFORM_LABEL[p]}`}
              >
                <div className="skeleton skeleton-avatar" />
                <div className="skeleton skeleton-title" />
                <div className="skeleton skeleton-copy" />
                <div className="skeleton skeleton-copy" />
              </section>
            ))
          : list.map((c) => {
              const canConnect = c.canConnect ?? c.configured;
              const pageOptions = c.platform === 'instagram'
                ? meta?.pages?.filter(page => page.instagram)
                : c.pages;
              const selectedPage = c.platform === 'instagram' ? meta?.selectedPageId : c.selectedPageId;
              const pageField = c.platform === 'instagram' ? 'instagram-page' : 'facebook-page';
              const status = c.needsReconnect
                ? 'Reconectar'
                : c.connected
                  ? 'Conectado'
                  : canConnect
                    ? 'Desconectado'
                    : 'Configuração pendente';
              return (
                <section
                  key={c.platform}
                  className={`conn ${c.platform} ${flash === c.platform ? 'connection-confirmed' : ''}`}
                >
                  <div className="connection-top">
                    <span className={`connection-icon platform-avatar ${c.platform}`}>
                      <Icon name={c.platform} size={27} />
                    </span>
                    <span
                      className={`badge ${c.connected && !c.needsReconnect ? 'st-published' : c.needsReconnect ? 'st-failed' : ''}`}
                    >
                      <span className="status-dot" />
                      {status}
                    </span>
                  </div>
                  <h2>{PLATFORM_LABEL[c.platform]}</h2>
                  <p className="connection-description">
                    {c.accountName ? (
                      <>
                        <span className="account-label">CONTA VINCULADA</span>
                        <strong>{c.accountName}</strong>
                      </>
                    ) : c.platform === 'instagram' ? (
                      'Sua conta profissional, conectada pela Página do Facebook.'
                    ) : c.platform === 'tiktok' ? (
                      'Crie aqui, publique no TikTok e acompanhe sua agenda.'
                    ) : (
                      'Seu conteúdo pronto para chegar à próxima audiência.'
                    )}
                  </p>
                  {(c.platform === 'facebook' || c.platform === 'instagram') && !!pageOptions?.length && (
                    <div className="field">
                      <label htmlFor={pageField}>{c.platform === 'instagram' ? 'Página vinculada ao Instagram' : 'Página de destino'}</label>
                      <select
                        id={pageField}
                        disabled={demo || busy !== null}
                        value={pageOptions.some(p => p.id === selectedPage) ? selectedPage : ''}
                        onChange={async (e) => {
                          setBusy(c.platform);
                          try {
                            await api.selectPage(e.target.value);
                            await load();
                            setCardErrors((previous) => ({ ...previous, [c.platform]: undefined }));
                          } catch (err: any) {
                            setCardErrors((previous) => ({
                              ...previous,
                              [c.platform]: err.message,
                            }));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        <option value="">Escolha uma Página…</option>
                        {pageOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.instagram ? ` · @${p.instagram.username}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {c.platform === 'facebook' && c.connected && !c.pages?.length && (
                    <p className="connection-limit">O Facebook foi autorizado, mas não retornou Páginas. Entre novamente e permita o acesso à Página que você administra.</p>
                  )}
                  {c.platform === 'instagram' && meta?.connected && !pageOptions?.length && (
                    <p className="connection-limit">Nenhuma Página com Instagram profissional foi retornada. Vincule o perfil profissional à Página no Facebook e autorize novamente.</p>
                  )}
                  <div className="connection-caps">
                    {c.capabilities.length ? (
                      c.capabilities.map((cap) => (
                        <span key={cap}>
                          <Icon name="check" size={12} />
                          {CAP_LABEL[cap] ?? cap}
                        </span>
                      ))
                    ) : (
                      <span>
                        <Icon name="calendar" size={13} />
                        Agenda manual disponível
                      </span>
                    )}
                  </div>
                  {cardErrors[c.platform] && (
                    <div className="alert error" role="alert">
                      {cardErrors[c.platform]}{' '}
                      <button className="link" disabled={busy !== null} onClick={() => void connect(c.platform)}>
                        Tentar de novo
                      </button>
                    </div>
                  )}
                  <div className="connection-actions">
                    {!demo && (
                      <button
                        className="primary"
                        disabled={!canConnect || busy !== null}
                        title={
                          !canConnect
                            ? 'Consulte os requisitos em “Sobre esta conexão”. A publicação manual está disponível.'
                            : undefined
                        }
                        onClick={() => void connect(c.platform)}
                      >
                        <Icon name="link" size={16} />
                        {busy === c.platform ? 'Abrindo login…' : c.connected ? 'Reconectar conta' : LOGIN_LABEL[c.platform]}
                      </button>
                    )}
                    <a
                      className="button"
                      href={PLATFORM_HOME[c.platform]}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Publicar manualmente
                      <Icon name="arrow" size={15} />
                    </a>
                  </div>
                  {!canConnect && (
                    <div className="connection-limit" role="status">
                      {c.blockers?.length ? c.blockers.map((reason,i)=><p key={i}>{reason}</p>) :
                        <p>Confira os requisitos em Sobre esta conexão e tente atualizar.</p>}
                      <button className="small" disabled={loading} onClick={load}>Verificar configuração novamente</button>
                    </div>
                  )}
                  <details className="connection-details">
                    <summary>
                      Sobre esta conexão
                      <Icon name="chevron" size={15} />
                    </summary>
                    <ul className="notes">
                      {c.notes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                      {c.platform === 'instagram' && (
                        <li>
                          A autorização usa a conexão do Facebook e uma Página com Instagram
                          profissional vinculado.
                        </li>
                      )}
                    </ul>
                    {!demo && c.connected && c.platform !== 'instagram' && (
                      <button
                        className="small danger"
                        disabled={busy === c.platform}
                        onClick={async () => {
                          if (!confirm('Desconectar e apagar os tokens salvos?')) return;
                          setBusy(c.platform);
                          try {
                            await api.disconnect(c.platform);
                            await load();
                          } catch (err: any) {
                            setCardErrors((previous) => ({
                              ...previous,
                              [c.platform]: err.message,
                            }));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Desconectar conta
                      </button>
                    )}
                  </details>
                </section>
              );
            })}
      </div>
      <div className="privacy-strip">
        <span>
          <Icon name="shield" size={23} />
        </span>
        <div>
          <h3>Suas conexões, protegidas.</h3>
          <p>
            Quando há conexão disponível, os tokens ficam criptografados no servidor. Seus segredos
            nunca são exibidos aqui.
          </p>
        </div>
        <a href="/privacidade">
          Sobre privacidade
          <Icon name="arrow" size={15} />
        </a>
      </div>
    </div>
  );
}
