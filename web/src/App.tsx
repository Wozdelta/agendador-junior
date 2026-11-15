import { AuthGate } from './components/AuthGate';
import { useCallback, useEffect, useState } from 'react';
import type { SettingsDTO } from '../../server/src/shared/types';
import { api } from './lib/api';
import { NewBatch } from './components/NewBatch';
import { Agenda } from './components/Agenda';
import { Connections } from './components/Connections';
import { SettingsPage } from './components/SettingsPage';
import { PrivacyPage, PublicFooter, TermsPage } from './legal/LegalPages';
import { LEGAL } from './legal/config';
import { ManualAgenda } from './components/ManualAgenda';
import { LiquidNav } from './components/LiquidNav';
import { BrandMark, Icon } from './components/ui/Icon';
import { GlassEffects } from './components/ui/GlassEffects';
import { MotionPreview } from './components/MotionPreview';

type Route = 'novo' | 'agenda' | 'conexoes' | 'config' | 'motion';
const ROUTES: Array<{ id: Route; label: string }> = [
  { id: 'novo', label: 'Novo lote' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'conexoes', label: 'Conexões' },
  { id: 'config', label: 'Configurações' },
];

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Route;
  return h === 'motion' || ROUTES.some((r) => r.id === h) ? h : 'novo';
}

/** /termos e /privacidade não dependem do backend; o resto abre direto no app. */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/termos') return <TermsPage />;
  if (path === '/privacidade') return <PrivacyPage />;
  return <AuthGate><MainApp /></AuthGate>;
}

function MainApp() {
  const [uploadMode,setUploadMode]=useState(false);
  const [route, setRoute] = useState<Route>(readRoute);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      setSettings(await api.settings());
      setBackendError(null);
    } catch (e: any) {
      setBackendError(e.message);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadSettings]);

  const go = (r: Route) => {
    window.location.hash = `#/${r}`;
  };
  const demo = settings?.mode === 'demo';
  const advanced = settings?.serverPersistence && settings?.mediaPersistence;

  return (
    <div className={demo ? 'app is-demo' : 'app'}>
      <GlassEffects />
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Pular para o conteúdo
      </a>
      {demo && (
        <div className="demo-banner" role="status">
          <strong>MODO DEMONSTRAÇÃO</strong> — contas e publicações são simuladas; nada é enviado às
          plataformas.{' '}
          <button className="link" onClick={() => go('config')}>
            Desativar
          </button>
        </div>
      )}
      <header className="topbar">
        <a className="brand" href="#/novo" aria-label={`${LEGAL.appName} — Novo lote`}>
          <BrandMark />
          <span>
            Agendador
            <span className="brand-junior">
              Junior<span className="brand-point">.</span>
            </span>
          </span>
        </a>
        <LiquidNav route={route} onChange={(r) => go(r as Route)} />
        <div className="header-detail">
          <Icon name="clock" size={16} />
          <span>
            Seu conteúdo.
            <br />
            <strong>No tempo certo.</strong>
          </span>
        </div>
      </header>
      <main className="content" id="main-content" tabIndex={-1}>
        {backendError && (
          <div className="alert error">
            {backendError} <button onClick={loadSettings}>Tentar de novo</button>
          </div>
        )}
        {route==='novo'&&advanced&&<div className="row"><button aria-pressed={!uploadMode} onClick={()=>setUploadMode(false)}>Agenda manual ? somente nomes</button><button aria-pressed={uploadMode} onClick={()=>setUploadMode(true)}>Upload e agendamento nativo</button></div>}
        {(!advanced || !uploadMode) && (
          <div hidden={route !== 'novo'} className={route === 'novo' ? 'page-enter' : ''}>
            <ManualAgenda view="create" />
          </div>
        )}
        {uploadMode && advanced && settings && route === 'novo' && (
          <div className="page-enter">
            <NewBatch settings={settings} key={settings.mode} />
          </div>
        )}
        <div key={route} className="page-enter route-content">
          {route === 'agenda' &&
            (settings ? (
              <Agenda settings={settings} key={settings.mode} />
            ) : (
              <ManualAgenda view="agenda" />
            ))}
          {settings && route === 'conexoes' && (
            <Connections settings={settings} key={settings.mode} />
          )}
          {settings && route === 'config' && (
            <SettingsPage settings={settings} onChange={setSettings} />
          )}
          {!settings && settingsLoading && (route === 'conexoes' || route === 'config') && (
            <div className="loading-state" role="status">
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-panel" />
              <span>Carregando {route === 'conexoes' ? 'conexões' : 'configurações'}…</span>
            </div>
          )}
          {!settings && !settingsLoading && (route === 'conexoes' || route === 'config') && (
            <div className="work-panel">
              <h2>Não foi possível abrir esta seção</h2>
              <p className="muted">
                Use Tentar de novo no aviso acima. Sua agenda manual continua disponível.
              </p>
              <a className="button" href="#/agenda">
                Abrir Agenda
                <Icon name="arrow" size={16} />
              </a>
            </div>
          )}
          {route === 'motion' && <MotionPreview />}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
