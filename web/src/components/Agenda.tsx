import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsDTO, TaskDTO, TaskState } from '../../../server/src/shared/types';
import { PLATFORM_LABEL, TASK_STATE_LABEL } from '../../../server/src/shared/types';
import { RULES, countText } from '../../../server/src/shared/limits';
import { api, downloadUrl, idemKey, type DraftAgendaRow } from '../lib/api';
import { isValidBrDate } from '../lib/date';
import { DateField } from './DateField';
import { ManualAgenda } from './ManualAgenda';
import { useDialogFocus } from './ui/useDialogFocus';
import { Icon } from './ui/Icon';

const ORDER: TaskState[] = [
  'draft',
  'queued',
  'processing',
  'scheduled_remote',
  'published',
  'manual_action',
  'late',
  'failed',
  'cancelled',
];

const COVER_LABEL: Record<string, string> = {
  none: 'sem capa personalizada',
  pending: 'capa pendente',
  applied: 'capa aplicada',
  frame: 'capa por quadro',
  manual: 'capa: aplicar manualmente',
  failed: 'capa precisa de atenção',
};

function stateLabel(t: TaskDTO): string {
  if (t.state === 'manual_action') {
    if (t.manualReason === 'tiktok_inbox') return 'Ação manual necessária · Enviado ao TikTok';
    if (t.manualReason === 'review_unknown')
      return 'Ação manual necessária · Revisar na plataforma';
  }
  if (t.state === 'published' && t.publishedManually) return 'Publicado (registro manual)';
  return TASK_STATE_LABEL[t.state];
}

type Dialog =
  | { kind: 'reschedule'; task: TaskDTO; key: string }
  | { kind: 'complete'; task: TaskDTO; key: string }
  | { kind: 'edit'; task: TaskDTO; key: string }
  | { kind: 'review'; task: TaskDTO; key: string };

export function Agenda({ settings }: { settings: SettingsDTO }) {
  return (
    <>
      <a className="button agenda-analytics" href="#/dashboard"><Icon name="dashboard" size={18} />Ver Dashboard</a>
      <ManualAgenda view="agenda" />
      {settings.serverPersistence && <ServerAgenda settings={settings} />}
    </>
  );
}

function ServerAgenda({ settings }: { settings: SettingsDTO }) {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [drafts, setDrafts] = useState<DraftAgendaRow[]>([]);
  const [filter, setFilter] = useState<TaskState | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!info) return;
    const timer = window.setTimeout(() => setInfo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [info]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.tasks();
      setTasks(r.tasks);
      setDrafts(r.drafts);
      if (r.warning) setError(r.warning);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { draft: drafts.length };
    for (const t of tasks) c[t.state] = (c[t.state] ?? 0) + 1;
    return c;
  }, [tasks, drafts]);

  const run = async (t: TaskDTO, fn: () => Promise<TaskDTO>) => {
    setBusy(t.id);
    setError(null);
    try {
      const nt = await fn();
      setTasks((ts) => ts.map((x) => (x.id === nt.id ? nt : x)));
      setDialog(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const shown = tasks.filter((t) => filter === 'all' || t.state === filter);
  const groups = new Map<string, TaskDTO[]>();
  for (const t of shown) {
    const day = t.plannedLocal.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), t]);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Registros do servidor</h2>
        <p className="muted">
          {settings.backgroundWorker
            ? 'O executor na nuvem processa as tarefas autorizadas. O PC pode ficar desligado; confira o resultado de cada plataforma.'
            : 'Não há fila automática nesta versão. Prepare envios nativos pelo botão abaixo; só o status “Agendado na plataforma” confirma a publicação futura sem o app aberto. As demais redes são manuais.'}
        </p>
      </div>
      {!settings.backgroundWorker && (
        <button
          className="primary server-action"
          disabled={!!busy || !settings.oauthAvailable}
          onClick={async () => {
            setBusy('native');
            setError(null);
            setInfo(null);
            try {
              const r = await api.processNative();
              setInfo(r.message);
              await load();
            } catch (err: any) {
              setError(err.message);
            } finally {
              setBusy(null);
            }
          }}
        >
          <Icon name={busy === 'native' ? 'clock' : 'calendar'} size={17} />
          {busy === 'native' ? 'Preparando envios…' : 'Preparar / retomar agendamentos nativos'}
        </button>
      )}
      {info && (
        <div className="alert success server-notice" role="status">
          <Icon name="check" />
          {info}
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}{' '}
          <button className="link" onClick={load}>
            Tentar de novo
          </button>
        </div>
      )}
      <div className="filters" role="toolbar" aria-label="Filtrar por estado">
        <button
          className={filter === 'all' ? 'chip active' : 'chip'}
          onClick={() => setFilter('all')}
        >
          Todos ({tasks.length})
        </button>
        {ORDER.map((s) => (
          <button
            key={s}
            className={filter === s ? `chip st-${s} active` : `chip st-${s}`}
            onClick={() => setFilter(s)}
            disabled={!counts[s]}
          >
            {TASK_STATE_LABEL[s]} ({counts[s] ?? 0})
          </button>
        ))}
      </div>

      {(filter === 'all' || filter === 'draft') && drafts.length > 0 && (
        <section className="panel">
          <h3>Rascunhos (ainda não agendados)</h3>
          <ul className="draft-rows">
            {drafts.map((d) => (
              <li key={d.itemId}>
                <span className="badge st-draft">Rascunho</span> {d.plannedLocal} · {d.originalName}{' '}
                · {d.platforms.map((p) => PLATFORM_LABEL[p]).join(', ')} <a href="#/novo">abrir</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {shown.length === 0 && filter !== 'draft' && (
        <p className="empty">
          Nenhuma tarefa {filter === 'all' ? 'agendada ainda' : 'neste estado'}.
        </p>
      )}

      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="day">
          <h3>{day}</h3>
          {list.map((t) => (
            <article key={t.id} className={`task st-${t.state}`}>
              <div className="task-main">
                <span className={`dot ${t.platform}`} />
                <div className="task-info">
                  <div className="task-title">
                    <strong>{PLATFORM_LABEL[t.platform]}</strong> · {t.accountName} ·{' '}
                    <span title={t.originalName}>{t.originalName}</span>
                    {t.mode === 'demo' && <span className="badge demo">DEMO</span>}
                  </div>
                  <div className="task-times">
                    <span>
                      Planejado: <strong>{t.plannedLocal}</strong>
                    </span>
                    <span>Efetivo: {t.effectiveLocal ?? '—'}</span>
                    {t.nativeSchedule && (
                      <span className="tag">
                        agendamento nativo{t.remoteId ? ` · ID ${t.remoteId}` : ''}
                      </span>
                    )}
                    {t.attempts > 0 && <span className="tag warn">tentativas: {t.attempts}</span>}
                  </div>
                  <div className="task-sub">
                    <span>Vídeo: {t.videoUploaded ? 'enviado' : 'não enviado'}</span>
                    {t.coverId || t.cover.state !== 'none' ? (
                      <span className={`cover-${t.cover.state}`}>{COVER_LABEL[t.cover.state]}</span>
                    ) : null}
                    {t.remoteUrl && (
                      <a href={t.remoteUrl} target="_blank" rel="noreferrer noopener">
                        abrir publicação
                      </a>
                    )}
                  </div>
                  {t.cover.message &&
                    (t.cover.state === 'failed' || t.cover.state === 'manual') && (
                      <div className="note">{t.cover.message}</div>
                    )}
                  {t.delayNote && <div className="note warn">{t.delayNote}</div>}
                  {t.lastError && <div className="note err">{t.lastError}</div>}
                  {t.state === 'manual_action' && t.manualReason !== 'review_unknown' && (
                    <ManualBox task={t} />
                  )}
                </div>
                <span className={`badge st-${t.state}`}>{stateLabel(t)}</span>
              </div>
              <div className="task-actions">
                {t.actions.includes('manual_complete') && (
                  <button
                    className="primary small"
                    disabled={busy === t.id}
                    onClick={() => setDialog({ kind: 'complete', task: t, key: idemKey() })}
                  >
                    Registrar publicação
                  </button>
                )}
                {t.actions.includes('resolve_review') && (
                  <button
                    className="primary small"
                    disabled={busy === t.id}
                    onClick={() => setDialog({ kind: 'review', task: t, key: idemKey() })}
                  >
                    Revisar resultado
                  </button>
                )}
                {t.actions.includes('retry') && (
                  <button
                    className="small"
                    disabled={busy === t.id}
                    onClick={() => run(t, () => api.taskAction(t.id, 'retry', {}, idemKey()))}
                  >
                    Tentar novamente
                  </button>
                )}
                {t.actions.includes('edit') && (
                  <button
                    className="small"
                    disabled={busy === t.id}
                    onClick={() => setDialog({ kind: 'edit', task: t, key: idemKey() })}
                  >
                    Editar
                  </button>
                )}
                {t.actions.includes('reschedule') && (
                  <button
                    className="small"
                    disabled={busy === t.id}
                    onClick={() => setDialog({ kind: 'reschedule', task: t, key: idemKey() })}
                  >
                    Nova data
                  </button>
                )}
                {t.actions.includes('cancel') && (
                  <button
                    className="small danger"
                    disabled={busy === t.id}
                    onClick={() =>
                      confirm(
                        t.nativeSchedule
                          ? 'Cancelar? O agendamento será removido na plataforma antes de marcar como cancelado.'
                          : 'Cancelar esta publicação?',
                      ) && run(t, () => api.taskAction(t.id, 'cancel', {}, idemKey()))
                    }
                  >
                    {busy === t.id ? 'Aguardando plataforma…' : 'Cancelar'}
                  </button>
                )}
                <button
                  className="link"
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                >
                  {expanded === t.id ? 'ocultar histórico' : 'histórico'}
                </button>
              </div>
              {expanded === t.id && (
                <ol className="history">
                  {t.history.map((h, i) => (
                    <li key={i}>
                      <time>
                        {new Date(h.at).toLocaleString('pt-BR', { timeZone: settings.timezone })}
                      </time>{' '}
                      {h.message}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          ))}
        </section>
      ))}

      {dialog && (
        <TaskDialog
          dialog={dialog}
          busy={busy === dialog.task.id}
          onClose={() => setDialog(null)}
          run={run}
          settings={settings}
        />
      )}
    </div>
  );
}

function ManualBox({ task }: { task: TaskDTO }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="manual-box">
      <p>
        {task.manualReason === 'tiktok_inbox'
          ? 'O vídeo está na caixa de entrada do TikTok. Abra o app, cole a descrição e publique. O app ainda não considera como publicado.'
          : `Publique manualmente no horário: baixe o vídeo, copie a descrição e poste em ${PLATFORM_LABEL[task.platform]}.`}
      </p>
      <pre className="caption">{task.description || '(sem descrição)'}</pre>
      <div className="row">
        <button
          className="small"
          onClick={async () => {
            await navigator.clipboard.writeText(task.description);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copiado!' : 'Copiar descrição'}
        </button>
        {task.mediaUrl && (
          <a className="button small" href={downloadUrl(task.mediaUrl)}>
            Baixar vídeo original
          </a>
        )}
        {task.coverUrl && (
          <a className="button small" href={downloadUrl(task.coverUrl)}>
            Baixar capa
          </a>
        )}
      </div>
    </div>
  );
}

function TaskDialog({
  dialog,
  busy,
  onClose,
  run,
  settings,
}: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  run: (t: TaskDTO, fn: () => Promise<TaskDTO>) => Promise<void>;
  settings: SettingsDTO;
}) {
  const t = dialog.task;
  useDialogFocus(true, () => {
    if (!busy) onClose();
  });
  const [date, setDate] = useState('');
  const [time, setTime] = useState(settings.publishTime);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState(t.title);
  const [desc, setDesc] = useState(t.description);
  const rules = RULES[t.platform];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        {dialog.kind === 'reschedule' && (
          <>
            <h2>Nova data · {PLATFORM_LABEL[t.platform]}</h2>
            {t.state === 'scheduled_remote' && (
              <p className="note">
                {t.platform === 'youtube'
                  ? 'O novo horário será enviado ao YouTube e só aparece aqui depois da confirmação.'
                  : 'O agendamento atual será removido na plataforma e o vídeo reenviado para a nova data.'}
              </p>
            )}
            <DateField label="Data" value={date} onChange={setDate} />
            <div className="field">
              <label>Horário (America/Sao_Paulo)</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button onClick={onClose}>Voltar</button>
              <button
                className="primary"
                disabled={busy || !isValidBrDate(date)}
                onClick={() =>
                  run(t, () => api.taskAction(t.id, 'reschedule', { date, time }, dialog.key))
                }
              >
                {busy ? 'Confirmando…' : 'Reagendar'}
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'complete' && (
          <>
            <h2>Registrar publicação manual</h2>
            <p>
              Confirme que você publicou este vídeo no {PLATFORM_LABEL[t.platform]}. O registro fica
              identificado como manual.
            </p>
            <div className="field">
              <label>Link publicado (opcional)</label>
              <input
                type="url"
                placeholder="https://www.tiktok.com/@…/video/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button onClick={onClose}>Voltar</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(t, () => api.taskAction(t.id, 'manual-complete', { url }, dialog.key))
                }
              >
                Marcar como publicado
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'review' && (
          <>
            <h2>Revisar resultado</h2>
            <p>
              O app não conseguiu confirmar se a publicação foi criada no{' '}
              {PLATFORM_LABEL[t.platform]}. Verifique na plataforma e informe o que encontrou. Isso
              evita publicar duas vezes.
            </p>
            <div className="field">
              <label>Link (se encontrou a publicação)</label>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button onClick={onClose}>Voltar</button>
              <button
                disabled={busy}
                onClick={() =>
                  run(t, () =>
                    api.taskAction(
                      t.id,
                      'resolve-review',
                      { outcome: 'not_published' },
                      dialog.key,
                    ),
                  )
                }
              >
                Não foi publicado — reenviar
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(t, () =>
                    api.taskAction(
                      t.id,
                      'resolve-review',
                      { outcome: 'published', url },
                      dialog.key,
                    ),
                  )
                }
              >
                Encontrei a publicação
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'edit' && (
          <>
            <h2>Editar · {PLATFORM_LABEL[t.platform]}</h2>
            {t.state === 'scheduled_remote' && (
              <p className="note">
                {t.platform === 'youtube'
                  ? 'A alteração será enviada ao YouTube e só é salva aqui depois da confirmação.'
                  : 'Esta plataforma não permite editar o agendamento: ele será removido e o vídeo reenviado com o novo texto.'}
              </p>
            )}
            {rules.title && (
              <div className="field">
                <label>
                  Título{' '}
                  <span className="counter">
                    {countText(title, rules.title.count)}/{rules.title.max}
                  </span>
                </label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label>
                Descrição{' '}
                <span className="counter">
                  {countText(desc, rules.description.count)}/{rules.description.max}
                </span>
              </label>
              <textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button onClick={onClose}>Voltar</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(t, () => api.editTask(t.id, { title, description: desc }, dialog.key))
                }
              >
                {busy ? 'Confirmando…' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
