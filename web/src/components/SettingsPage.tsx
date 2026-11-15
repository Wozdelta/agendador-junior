import { useState } from 'react';
import type { Platform, SettingsDTO } from '../../../server/src/shared/types';
import { PLATFORM_LABEL, PLATFORMS } from '../../../server/src/shared/types';
import { api } from '../lib/api';

const FAULTS: Array<{ id: string; label: string }> = [
  { id: 'fail', label: 'Falha definitiva' },
  { id: 'transient', label: 'Falha temporária (nova tentativa)' },
  { id: 'timeout', label: 'Timeout após envio (reconcilia pelo ID)' },
  { id: 'unverifiable', label: 'Resultado desconhecido (revisão manual)' },
];

export function SettingsPage({ settings, onChange }: { settings: SettingsDTO; onChange: (s: SettingsDTO) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [fp, setFp] = useState<Platform>('instagram');
  const [fk, setFk] = useState('fail');
  const demo = settings.mode === 'demo';

  const toggle = async () => {
    const next = demo ? 'real' : 'demo';
    const msg =
      next === 'demo'
        ? 'Ativar o MODO DEMONSTRAÇÃO?\n\nVocê verá dados separados e contas simuladas. Nada será publicado. Seus lotes reais continuam guardados e a fila real continua rodando.'
        : 'Voltar ao MODO REAL?\n\nOs lotes confirmados neste modo usam suas contas conectadas e publicam de verdade.';
    if (!confirm(msg)) return;
    try {
      onChange(await api.setMode(next));
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <h1>Configurações</h1>
      {error && <div className="alert error">{error}</div>}
      {info && <div className="alert success">{info}</div>}

      <section className="panel">
        <h3>Modo de operação</h3>
        <p>
          Modo atual: <strong>{demo ? 'DEMONSTRAÇÃO (simulado)' : 'REAL'}</strong>
        </p>
        <p className="muted">
          Os dados de demonstração ficam em <code>data/demo/</code> e os reais em <code>data/real/</code>. Conectores simulados nunca acessam a rede, e os reais nunca processam
          tarefas de demonstração.
        </p>
        <button className={demo ? 'primary' : ''} onClick={toggle} disabled={!settings.backgroundWorker}>
          {demo ? 'Desativar demonstração e voltar ao modo real' : 'Ativar modo demonstração'}
        </button>
      </section>
      {!settings.backgroundWorker && <div className="alert">A agenda manual funciona sem serviços externos e salva registros neste navegador. OAuth só salva tokens com persistência no servidor e criptografia. Vídeos exigem armazenamento próprio. Não há cron ou fila de publicação futura nesta versão.</div>}

      {demo && (
        <section className="panel">
          <h3>Simular falhas (somente demonstração)</h3>
          <p className="muted">A próxima chamada simulada da plataforma escolhida vai falhar do jeito indicado.</p>
          <div className="row">
            <select value={fp} onChange={(e) => setFp(e.target.value as Platform)}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </option>
              ))}
            </select>
            <select value={fk} onChange={(e) => setFk(e.target.value)}>
              {FAULTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
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
              Programar
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h3>Parâmetros (definidos no .env)</h3>
        <dl className="kv">
          <dt>Fuso horário</dt>
          <dd>{settings.timezone}</dd>
          <dt>Horário de publicação</dt>
          <dd>{settings.publishTime}</dd>
          <dt>Tolerância de atraso</dt>
          <dd>{settings.lateToleranceMinutes} min (LATE_TOLERANCE_MINUTES)</dd>
          <dt>Antecedência mínima</dt>
          <dd>{settings.minLeadMinutes} min (MIN_LEAD_MINUTES)</dd>
          <dt>Endereço HTTPS público</dt>
          <dd>{settings.publicBaseUrlConfigured ? 'configurado (links temporários para a Meta)' : 'não configurado'}</dd>
          <dt>TikTok</dt>
          <dd>{settings.tiktokMode === 'manual' ? 'publicação manual' : settings.tiktokMode === 'inbox' ? 'envio à caixa de entrada' : 'Direct Post'}</dd>
          <dt>Meta Graph API</dt>
          <dd>{settings.graphVersion}</dd>
        </dl>
      </section>
    </div>
  );
}
