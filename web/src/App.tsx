import { useCallback, useEffect, useState } from 'react';
import type { SessionDTO, SettingsDTO } from '../../server/src/shared/types';
import { api, ApiError } from './lib/api';
import { NewBatch } from './components/NewBatch';
import { Agenda } from './components/Agenda';
import { Connections } from './components/Connections';
import { SettingsPage } from './components/SettingsPage';
import { PrivacyPage, PublicFooter, TermsPage } from './legal/LegalPages';
import { LEGAL } from './legal/config';

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

/** Páginas públicas (sem login e sem depender do backend). */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/termos') return <TermsPage />;
  if (path === '/privacidade') return <PrivacyPage />;
  return <Shell />;
}

function Shell() {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.session());
      setBackendError(null);
    } catch (e: any) {
      setBackendError(e instanceof ApiError && e.status === 0 ? 'Sem conexão com o backend.' : e.message);
    }
  }, []);

  useEffect(() => {
    loadSession();
    const onLogin = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener('agj:login-required', onLogin);
    return () => window.removeEventListener('agj:login-required', onLogin);
  }, [loadSession]);

  if (!session || !session.authenticated) {
    return <Landing session={session} backendError={backendError} onRetry={loadSession} onLoggedIn={loadSession} />;
  }
  return <MainApp session={session} onLogout={loadSession} />;
}

/** Página inicial pública: descreve o app, faz login e mostra os links legais. */
function Landing({
  session,
  backendError,
  onRetry,
  onLoggedIn,
}: {
  session: SessionDTO | null;
  backendError: string | null;
  onRetry: () => void;
  onLoggedIn: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
      onLoggedIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <main className="landing-main">
        <div className="brand big">
          <span className="logo" aria-hidden>▶</span>
          <span>{LEGAL.appName}</span>
        </div>
        <p className="lead">
          Agendamento em lote de vídeos curtos para Facebook Reels, YouTube Shorts, Instagram Reels e TikTok — um vídeo por dia, às 12:00 (horário de Brasília), com textos
          e situação separados por plataforma.
        </p>
        <ul className="landing-points">
          <li>Conexão às contas pelos fluxos oficiais de autorização de cada plataforma.</li>
          <li>Agenda com o estado de cada publicação: na fila, agendado na plataforma, publicado, ação manual necessária.</li>
          <li>TikTok no modo pessoal: lembrete com a descrição para copiar e o vídeo para baixar, e publicação manual pelo app do TikTok.</li>
        </ul>

        <section className="panel login">
          <h2>Acesso</h2>
          {backendError && (
            <div className="alert error" role="alert">
              {backendError} <button className="link" onClick={onRetry}>Tentar de novo</button>
            </div>
          )}
          {!session && !backendError && <p className="muted">Verificando…</p>}
          {session && !session.loginConfigured && (
            <div className="alert error">O login remoto ainda não foi configurado no backend (APP_PASSWORD_HASH e TOKEN_ENCRYPTION_KEY).</div>
          )}
          {session && session.loginConfigured && (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="senha">Senha</label>
                <input id="senha" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              {error && (
                <div className="field-error" role="alert">
                  {error}
                </div>
              )}
              <button className="primary" disabled={busy || !password}>
                {busy ? 'Entrando…' : 'Entrar'}
              </button>
            </form>
          )}
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

function MainApp({ session, onLogout }: { session: SessionDTO; onLogout: () => void }) {
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
        {session.loginRequired && (
          <button
            className="small"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              onLogout();
            }}
          >
            Sair
          </button>
        )}
      </header>
      {session.loginRequired && !session.directLinks && (
        <div className="alert error content-alert">
          O backend não tem PUBLIC_BASE_URL configurado: envios de vídeo pela versão hospedada não vão funcionar (limite de 4,5 MB da Vercel).
        </div>
      )}
      <main className="content">
        {backendError && (
          <div className="alert error">
            {backendError} <button onClick={loadSettings}>Tentar de novo</button>
          </div>
        )}
        {settings && route === 'novo' && <NewBatch settings={settings} key={settings.mode} />}
        {settings && route === 'agenda' && <Agenda settings={settings} key={settings.mode} />}
        {settings && route === 'conexoes' && <Connections settings={settings} key={settings.mode} />}
        {settings && route === 'config' && <SettingsPage settings={settings} onChange={setSettings} />}
      </main>
      <PublicFooter />
    </div>
  );
}
