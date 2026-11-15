import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { BrandMark } from './ui/Icon';
const Session = createContext<{ id: string; email: string } | null>(null);
export const useSession = () => useContext(Session);
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    try {
      setUser((await api.session()).user);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const expired = () => {
      setUser(null);
      setError('Sua sessão expirou. Entre novamente.');
    };
    window.addEventListener('agendador-session-expired', expired);
    return () => window.removeEventListener('agendador-session-expired', expired);
  }, []);
  if (loading)
    return (
      <main className="login-page">
        <div className="work-panel" role="status">
          Verificando sessão…
        </div>
      </main>
    );
  if (user)
    return (
      <Session.Provider value={user}>
        <div className="session-bar">
          <span>{user.email}</span>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.logout();
                setUser(null);
                setPassword('');
                setError('');
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Sair
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
        {children}
      </Session.Provider>
    );
  return (
    <main className="login-page">
      <section className="work-panel login-panel">
        <BrandMark />
        <h1>Entre no Agendador Junior</h1>
        <p className="muted">
          Entre com o e-mail e a senha da conta administradora.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              setUser((await api.login(email, password)).user);
              setPassword('');
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            E-mail
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p>
          <a href="/termos">Termos de Uso</a> · <a href="/privacidade">Política de Privacidade</a>
        </p>
      </section>
    </main>
  );
}
