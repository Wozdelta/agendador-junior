import { useEffect, useState } from 'react';
import type { ConnectionDTO, Platform, SettingsDTO } from '../../../server/src/shared/types';
import { PLATFORM_LABEL, PLATFORMS } from '../../../server/src/shared/types';
import { api } from '../lib/api';
import { PLATFORM_HOME } from './ManualAgenda';
import { Icon } from './ui/Icon';
import { STATE_LABEL, type AnalyticsDTO } from '../../../server/src/shared/analytics';
export const validConnection = (c: ConnectionDTO) => c.connected && !c.needsReconnect && !!c.accountId && !!c.accountName;
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
  const [metrics,setMetrics]=useState<AnalyticsDTO|null>(null);
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
      void api.analytics().then(setMetrics).catch(()=>{});
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
  const connectedCount=list.filter(validConnection).length;
  const allConnected=list.length===4&&connectedCount===4;
  const authorize=async(p:Platform)=>{
    setBusy(p);try{const {url}=await api.authorizeAnalytics(p);window.location.assign(url);}catch(e:any){setCardErrors(old=>({...old,[p]:e.message}));}finally{setBusy(null);}
  };
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
    <div className={`connections-page ${allConnected?'all-connected':'setup-connections'}`}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SUAS REDES, NO MESMO LUGAR</span>
          <h1>
            Conexões<span className="accent-dot">.</span>
          </h1>
          <p>{allConnected?'Suas contas prontas. Acompanhe o desempenho e gerencie cada conexão.':'Conecte suas contas e autorize os recursos que deseja usar.'}</p>
        </div>
        <span className="context-badge">
          <Icon name="link" size={15} />
          {connectedCount} de 4 plataformas conectadas
        </span>
      </div>
      {demo && (
        <div className="alert demo">Modo demonstração: contas e publicações são simuladas.</div>
      )}
      <div className="work-panel connection-overview">
        <strong>{allConnected?<span className={flash?'completion-check animate-check':'completion-check'}><Icon name="check" size={28}/></span>:`${connectedCount}/4`}</strong>
        <span>{allConnected?'4 plataformas conectadas':`${connectedCount} de 4 plataformas conectadas`}<br /><small>Confira a conta e o destino de cada publicação.</small></span>
        <a href="#/dashboard" className={allConnected?'button primary':'button'}>Abrir Dashboard<Icon name="arrow" size={16}/></a>
        <button onClick={() => void load()} disabled={loading}>{loading ? 'Verificando…' : 'Atualizar conexões'}</button>
      </div>
      {!allConnected&&<div className="work-panel connection-login-guide">
        <strong>Conecte em três passos</strong>
        <p>Escolha uma rede, faça login na página oficial e permita o acesso. Depois, você volta para cá com a conta vinculada.</p>
        <p className="muted">Digite a senha da rede somente no site oficial. Para Instagram, entre pelo Facebook e selecione a Página vinculada ao perfil profissional.</p>
      </div>}
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
              const analytic=metrics?.platforms.find(p=>p.platform===c.platform);
              const displayName=analytic?.report?.accountName ?? c.accountName;
              const health=(c.analytics?.state==='expired'||c.analytics?.state==='permission')?c.analytics.state:analytic?.state ?? c.analytics?.state ?? 'no_data';
              const needsAnalytics=c.connected&&(health==='permission'||health==='expired'||(c.analytics?.missingScopes.length??0)>0);
              const accountValid=validConnection(c);
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
                      {analytic?.avatar?<img src={analytic.avatar} alt="" referrerPolicy="no-referrer"/>:<Icon name={c.platform} size={27} />}
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
                    {displayName ? (
                      <>
                        <span className="account-label">CONTA VINCULADA</span>
                        <strong>{displayName}</strong>
                      </>
                    ) : c.platform === 'instagram' ? (
                      'Sua conta profissional, conectada pela Página do Facebook.'
                    ) : c.platform === 'tiktok' ? (
                      'Crie aqui, publique no TikTok e acompanhe sua agenda.'
                    ) : (
                      'Seu conteúdo pronto para chegar à próxima audiência.'
                    )}
                  </p>
                  <div className="connection-resource-status">
                    <span>Analytics <strong>{STATE_LABEL[health]}</strong></span>
                    <span>Publicação <strong>{accountValid?(c.capabilities.includes('native_schedule')?'Agendamento nativo':c.capabilities.includes('direct')?'Direct Post':c.capabilities.includes('inbox')?'Caixa de entrada':'Manual disponível'):'Conecte a conta'}</strong></span>
                    {accountValid&&c.platform==='tiktok'&&c.schedulerConfigured===false&&(c.capabilities.includes('direct')||c.capabilities.includes('inbox'))&&<small>API autorizada. Configure o executor na nuvem para agendar os envios.</small>}
                    <span>Monetização <strong>{analytic?.report?.metrics.revenue?.value!=null?'Estimativa disponível':c.monetization==='permission_granted'?'Permissão concedida; disponibilidade a verificar':'Sem dados confirmados'}</strong></span>
                    <small>Última sincronização: {(analytic?.lastSuccess ?? c.analytics?.lastSync)?new Date((analytic?.lastSuccess ?? c.analytics?.lastSync)!).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Ainda não sincronizada'}</small>
                  </div>
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
                        disabled={(!canConnect&&!accountValid) || busy !== null}
                        title={
                          !canConnect
                            ? 'Consulte os requisitos em “Sobre esta conexão”. A publicação manual está disponível.'
                            : undefined
                        }
                        onClick={(event) => {
                          if(accountValid){const details=event.currentTarget.closest('section')?.querySelector('details');if(details){details.open=true;details.scrollIntoView?.({block:'nearest',behavior:'smooth'});}}
                          else void connect(c.platform);
                        }}
                      >
                        <Icon name="link" size={16} />
                        {busy === c.platform ? 'Abrindo login…' : accountValid ? 'Gerenciar conta' : c.needsReconnect ? 'Reconectar' : LOGIN_LABEL[c.platform]}
                      </button>
                    )}
                    {!demo&&needsAnalytics&&<button className="analytics-authorize" disabled={busy!==null} onClick={()=>void authorize(c.platform)}>{health==='expired'?'Reconectar Analytics':'Autorizar Analytics'}</button>}
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
                    {!demo&&c.connected&&<button disabled={busy!==null} onClick={()=>void connect(c.platform)}>Reconectar conta</button>}
                    {!demo && c.connected && (
                      <button
                        className="small danger"
                        disabled={busy === c.platform}
                        onClick={async () => {
                          if (!confirm(c.platform==='facebook'?'Desconectar Facebook também interrompe a autorização compartilhada com Instagram. Continuar?':`Desconectar ${PLATFORM_LABEL[c.platform]}?`)) return;
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
