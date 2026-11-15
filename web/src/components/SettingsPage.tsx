import { useState } from 'react';
import type { Platform, SettingsDTO } from '../../../server/src/shared/types';
import { PLATFORM_LABEL, PLATFORMS } from '../../../server/src/shared/types';
import { api } from '../lib/api';
import { Icon } from './ui/Icon';
const FAULTS = [
  { id: 'fail', label: 'Falha definitiva' },
  { id: 'transient', label: 'Falha temporária' },
  { id: 'timeout', label: 'Timeout após envio' },
  { id: 'unverifiable', label: 'Resultado desconhecido' },
];
export function SettingsPage({
  settings,
  onChange,
}: {
  settings: SettingsDTO;
  onChange: (s: SettingsDTO) => void;
}) {
  const [error, setError] = useState<string | null>(null),
    [info, setInfo] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [fp, setFp] = useState<Platform>('instagram'),
    [fk, setFk] = useState('fail');
  const demo = settings.mode === 'demo';
  const toggle = async () => {
    const next = demo ? 'real' : 'demo';
    if (
      !confirm(
        next === 'demo'
          ? 'Ativar o MODO DEMONSTRAÇÃO? Contas e publicações serão simuladas em dados separados. Seus lotes reais continuam guardados.'
          : 'Voltar ao modo real? Os lotes confirmados neste modo usam suas contas conectadas.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.setMode(next));
      setInfo('Modo de operação atualizado.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">DO SEU JEITO, COM CLAREZA</span>
          <h1>
            Configurações<span className="accent-dot">.</span>
          </h1>
          <p>Conheça seu espaço de trabalho e como seus registros são guardados.</p>
        </div>
        <span className="context-badge">
          <Icon name="settings" size={15} />
          Seu espaço de trabalho
        </span>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={toggle} disabled={busy}>
            Tentar de novo
          </button>
        </div>
      )}
      {info && (
        <div className="alert success" role="status">
          <Icon name="check" />
          {info}
        </div>
      )}
      <div className="settings-grid">
        <section className="work-panel">
          <div className="section-heading">
            <span className="settings-symbol">
              <Icon name="calendar" />
            </span>
            <h2>Seu ritmo de publicação</h2>
            <span className="optional-label">AGENDA</span>
          </div>
          <dl className="settings-values">
            <div>
              <dt>Horário diário</dt>
              <dd className="time-value">
                {settings.publishTime}
                <small>Horário de Brasília</small>
              </dd>
            </div>
            <div>
              <dt>Fuso horário</dt>
              <dd>
                {settings.timezone}
                <small>Um vídeo por dia corrido</small>
              </dd>
            </div>
            <div>
              <dt>Antecedência mínima</dt>
              <dd>{settings.minLeadMinutes} minutos</dd>
            </div>
            <div>
              <dt>Tolerância de atraso</dt>
              <dd>{settings.lateToleranceMinutes} minutos</dd>
            </div>
          </dl>
          <p className="settings-footnote">
            Parâmetros do servidor. O planejamento manual mantém o horário das 12:00.
          </p>
        </section>
        <section className="work-panel">
          <div className="section-heading">
            <span className="settings-symbol">
              <Icon name="shield" />
            </span>
            <h2>Dados e privacidade</h2>
          </div>
          <div className="setting-status">
            <div>
              <strong>Agenda manual</strong>
              <span>Registros salvos na sua conta, no Supabase.</span>
            </div>
            <span className="badge st-published">
              <Icon name="check" size={12} />
              Disponível
            </span>
          </div>
          <div className="setting-status">
            <div>
              <strong>Persistência no servidor</strong>
              <span>Para conexões e registros compartilhados pelo app.</span>
            </div>
            <span className="badge">
              {settings.serverPersistence ? 'Configurada' : 'Não configurada'}
            </span>
          </div>
          <div className="setting-status">
            <div>
              <strong>Armazenamento de mídia</strong>
              <span>Vídeos e capas, quando o recurso está disponível.</span>
            </div>
            <span className="badge">{settings.mediaPersistence ? 'Configurado' : 'Manual'}</span>
          </div>
          <a className="settings-text-link" href="/privacidade">
            Ler a Política de Privacidade
            <Icon name="arrow" size={15} />
          </a>
        </section>
        <section className="work-panel">
          <div className="section-heading">
            <span className="settings-symbol">
              <Icon name="spark" />
            </span>
            <h2>Modo de operação</h2>
          </div>
          <div className="setting-status">
            <div>
              <strong>Demonstração</strong>
              <span>
                {demo
                  ? 'Ativa. Contas e publicações são simuladas.'
                  : 'Explore os conectores sem publicar conteúdo real.'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={demo}
              aria-label="Modo demonstração"
              className={`liquid-toggle ${demo ? 'is-on' : ''}`}
              onClick={toggle}
              disabled={!settings.backgroundWorker || busy}
            >
              <span />
            </button>
          </div>
          <p className="settings-footnote">
            {settings.backgroundWorker
              ? 'Os dados de demonstração e os reais ficam separados. A mudança pede confirmação.'
              : 'Demonstração com fila disponível somente na execução local. Aqui, a agenda manual não depende de integrações.'}
          </p>
          {demo && (
            <div className="fault-controls">
              <h3>Simular uma falha</h3>
              <label>
                Plataforma
                <select value={fp} onChange={(e) => setFp(e.target.value as Platform)}>
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tipo de falha
                <select value={fk} onChange={(e) => setFk(e.target.value)}>
                  {FAULTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={async () => {
                  try {
                    await api.setFault(fp, fk);
                    setInfo(`Falha programada para ${PLATFORM_LABEL[fp]}.`);
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Programar simulação
              </button>
            </div>
          )}
        </section>
        <section className="work-panel">
          <div className="section-heading">
            <span className="settings-symbol">
              <Icon name="link" />
            </span>
            <h2>Publicação e conexões</h2>
          </div>
          <div className="setting-status">
            <div>
              <strong>TikTok</strong>
              <span>
                {settings.tiktokMode === 'manual'
                  ? 'Publicação manual na plataforma.'
                  : settings.tiktokMode === 'inbox'
                    ? 'Envio à caixa de entrada.'
                    : 'Direct Post disponível.'}
              </span>
            </div>
            <Icon name="tiktok" size={22} />
          </div>
          <div className="setting-status">
            <div>
              <strong>Execução futura do app</strong>
              <span>
                {settings.backgroundWorker
                  ? 'Depende do servidor local ligado.'
                  : 'Indisponível. Prepare envios nativos ou publique manualmente.'}
              </span>
            </div>
          </div>
          <dl className="kv">
            <dt>Endereço público</dt>
            <dd>{settings.publicBaseUrlConfigured ? 'Configurado' : 'Não configurado'}</dd>
            <dt>Meta Graph API</dt>
            <dd>{settings.graphVersion}</dd>
          </dl>
          <a className="settings-text-link" href="#/conexoes">
            Gerenciar conexões
            <Icon name="arrow" size={15} />
          </a>
        </section>
        <section className="work-panel">
          <h2>Importar backup do servidor anterior</h2>
          {importError && (
            <p role="alert" className="alert error">
              {importError} Selecione o arquivo novamente para tentar.
            </p>
          )}
          <p className="muted">
            Para lotes e conexões de um backend antigo. IDs existentes são preservados. Tokens devem
            estar criptografados com a mesma chave. Arquivos de vídeo não são transferidos.
          </p>
          <label>
            Backup JSON (até 900 KB)
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 900000) {
                  setImportError('Divida o backup em arquivos de até 900 KB.');
                  return;
                }
                setBusy(true);
                setImportError(null);
                try {
                  const result = await api.importLegacy(JSON.parse(await file.text()));
                  setInfo(
                    `Backup importado: ${Object.values(result.imported).reduce((a, b) => a + b, 0)} registro(s) novo(s). IDs existentes foram ignorados.`,
                  );
                } catch (error: any) {
                  setImportError(error.message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          <p className="muted">
            O formato do backup está documentado em supabase/README.md. Importe apenas sua cópia
            confiável.
          </p>
        </section>
      </div>
    </div>
  );
}
