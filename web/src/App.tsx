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

type Route = 'novo' | 'agenda' | 'conexoes' | 'config';
const ROUTES: Array<{ id: Route; label: string }> = [
  { id: 'novo', label: 'Novo lote' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'conexoes', label: 'Conexões' },
  { id: 'config', label: 'Configurações' },
];

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Route;
  return ROUTES.some((r) => r.id === h) ? h : 'novo';
}

/** /termos e /privacidade não dependem do backend; o resto abre direto no app. */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/termos') return <TermsPage />;
  if (path === '/privacidade') return <PrivacyPage />;
  return <MainApp />;
}

function MainApp() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
      setBackendError(null);
    } catch (e: any) {
      setBackendError(e.message);
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

  return (
    <div className={demo ? 'app is-demo' : 'app'}>
      {demo && (
        <div className="demo-banner" role="status">
          <strong>MODO DEMONSTRAÇÃO</strong> — contas e publicações são simuladas; nada é enviado às plataformas.{' '}
          <button className="link" onClick={() => go('config')}>Desativar</button>
        </div>
      )}
      <header className="topbar">
        <a className="brand" href="/">
          <span className="logo" aria-hidden>▶</span>
          <span>{LEGAL.appName}</span>
        </a>
        <nav className="tabs" aria-label="Seções">
          {ROUTES.map((r) => (
            <button key={r.id} className={route === r.id ? 'tab active' : 'tab'} onClick={() => go(r.id)} aria-current={route === r.id ? 'page' : undefined}>
              {r.label}
            </button>
          ))}
        </nav>
        {settings && <span className={demo ? 'mode-pill demo' : 'mode-pill'}>{demo ? 'Demonstração' : 'Modo real'}</span>}
      </header>
      <main className="content">
        {backendError && (
          <div className="alert error">
            {backendError} <button onClick={loadSettings}>Tentar de novo</button>
          </div>
        )}
        {settings && route === 'novo' && (settings.serverPersistence && settings.mediaPersistence ? <NewBatch settings={settings} key={settings.mode} /> : <ManualAgenda />)}
        {!settings && (route === 'novo' || route === 'agenda') && <ManualAgenda />}
        {settings && route === 'agenda' && <Agenda settings={settings} key={settings.mode} />}
        {settings && route === 'conexoes' && <Connections settings={settings} key={settings.mode} />}
        {settings && route === 'config' && <SettingsPage settings={settings} onChange={setSettings} />}
      </main>
      <PublicFooter />
    </div>
  );
}
