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
    [code, setCode] = useState(''),
    [sent, setSent] = useState(false),
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
                setCode('');
                setSent(false);
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
          Use o e-mail administrador. Você receberá um código temporário para entrar com segurança.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              if (sent) {
                setUser((await api.verifyCode(email, code)).user);
                setCode('');
              } else {
                await api.requestCode(email);
                setSent(true);
              }
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
              disabled={sent || busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {sent && (
            <>
              <p role="status">Confira sua caixa de entrada e a pasta de spam.</p>
              <label>
                Código temporário
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,10}"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Aguarde…' : sent ? 'Entrar' : 'Enviar código'}
          </button>
          {sent && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSent(false);
                setCode('');
              }}
            >
              Alterar e-mail / solicitar outro código
            </button>
          )}
          {!sent && error && (
            <button type="button" onClick={() => void load()}>
              Tentar de novo
            </button>
          )}
        </form>
        <p>
          <a href="/termos">Termos de Uso</a> · <a href="/privacidade">Política de Privacidade</a>
        </p>
      </section>
    </main>
  );
}
