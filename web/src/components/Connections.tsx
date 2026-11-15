import { useEffect, useState } from 'react';
import type { ConnectionDTO, Platform, SettingsDTO } from '../../../server/src/shared/types';
import { PLATFORM_LABEL } from '../../../server/src/shared/types';
import { api } from '../lib/api';
import { PLATFORM_HOME } from './ManualAgenda';

const CAP_LABEL: Record<string, string> = {
  native_schedule: 'Agendamento nativo',
  cover_image: 'Capa por imagem',
  cover_frame: 'Capa por quadro',
  queue: 'Publicação pela fila do app',
  queue_fallback: 'Publicação direta no horário (fallback)',
  resumable: 'Upload retomável',
  manual: 'Publicação manual',
  inbox: 'Envio à caixa de entrada',
  direct: 'Direct Post',
};

export function Connections({ settings }: { settings: SettingsDTO }) {
  const [list, setList] = useState<ConnectionDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const [flash] = useState(() => (params.get('conectado') ? `Conta conectada: ${params.get('conectado')}` : null));
  const [flashErr] = useState(() => params.get('erro'));

  const load = () => { setError(null); return api.connections().then(setList).catch((e) => setError(e.message)); };
  useEffect(() => {
    load();
  }, []);

  const connect = (p: Platform) => {
    window.location.href = `/api/connections/${p}/start?return=${encodeURIComponent(window.location.origin)}`;
  };
  const demo = settings.mode === 'demo';

  return (
    <div className="page">
      <div className="page-head">
        <h1>Conexões</h1>
        <p className="muted">
          Os tokens ficam só no servidor, criptografados (AES-256-GCM). Esta tela recebe apenas o nome da conta, o estado e as capacidades.
        </p>
      </div>
      {demo && <div className="alert demo">Modo demonstração: as contas abaixo são simuladas. Desative o modo em Configurações para conectar contas reais.</div>}
      {flash && <div className="alert success">{flash}</div>}
      {flashErr && <div className="alert error">Falha na conexão: {flashErr}</div>}
      {error && <div className="alert error" role="alert">{error} <button onClick={load}>Tentar de novo</button></div>}
      <div className="conn-grid">
        {list.map((c) => (
          <section key={c.platform} className={`conn ${c.platform}`}>
            <header>
              <span className={`dot ${c.platform}`} />
              <h3>{PLATFORM_LABEL[c.platform]}</h3>
              <span className={c.connected && !c.needsReconnect ? 'badge st-published' : c.needsReconnect ? 'badge st-failed' : 'badge'}>
                {c.needsReconnect ? 'Reconectar' : c.connected ? 'Conectado' : c.platform === 'tiktok' ? 'Manual' : 'Não conectado'}
              </span>
            </header>
            {c.accountName && (
              <p>
                {c.platform === 'youtube' ? 'Canal autorizado' : c.platform === 'facebook' ? 'Usuário' : 'Conta'}: <strong>{c.accountName}</strong>
              </p>
            )}
            {c.platform === 'facebook' && c.pages && (
              <div className="field">
                <label>Página de destino</label>
                <select
                  value={c.selectedPageId ?? ''}
                  disabled={demo}
                  onChange={async (e) => {
                    try {
                      await api.selectPage(e.target.value);
                      load();
                    } catch (err: any) {
                      setError(err.message);
                    }
                  }}
                >
                  <option value="">Escolha…</option>
                  {c.pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.instagram ? ` (Instagram @${p.instagram.username})` : ' (sem Instagram profissional)'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {c.capabilities.length > 0 && (
              <ul className="caps">
                {c.capabilities.map((k) => (
                  <li key={k}>✓ {CAP_LABEL[k] ?? k}</li>
                ))}
              </ul>
            )}
            {c.notes.length > 0 && (
              <ul className="notes">
                {c.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            {!demo && (
              <div className="row">
                {c.platform !== 'instagram' && (
                  <button className="primary small" disabled={!(c.canConnect ?? c.configured)} onClick={() => connect(c.platform)} title="Consulte os requisitos desta conexão acima">
                    {c.connected ? 'Reconectar' : 'Conectar'}
                  </button>
                )}
                {c.platform === 'instagram' && <span className="muted">Usa a conexão do Facebook (Página com Instagram profissional vinculado).</span>}
                {c.connected && c.platform !== 'instagram' && (
                  <button
                    className="small danger"
                    onClick={async () => {
                      if (!confirm('Desconectar e apagar os tokens salvos?')) return;
                      await api.disconnect(c.platform);
                      load();
                    }}
                  >
                    Desconectar
                  </button>
                )}
              </div>
            )}
            <a className="button small" href={PLATFORM_HOME[c.platform]} target="_blank" rel="noreferrer">Publicar manualmente</a>
          </section>
        ))}
      </div>
    </div>
  );
}
