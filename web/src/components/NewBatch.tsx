import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BatchDTO,
  BatchSummary,
  ConnectionDTO,
  Platform,
  PlatformTexts,
  SettingsDTO,
} from '../../../server/src/shared/types';
import { PLATFORM_LABEL, PLATFORMS } from '../../../server/src/shared/types';
import { api, ApiError, idemKey, uploadFile } from '../lib/api';
import { isValidBrDate } from '../lib/date';
import { DateField } from './DateField';
import { VideoCard, type UploadState } from './VideoCard';
import { Icon } from './ui/Icon';
import { useDialogFocus } from './ui/useDialogFocus';

type Patch = {
  platforms?: Partial<Record<Platform, Partial<PlatformTexts>>>;
  coverFrameMs?: number;
};
const UPLOAD_CONCURRENCY = 2;

export function NewBatch({ settings }: { settings: SettingsDTO }) {
  const [drafts, setDrafts] = useState<BatchDTO[]>([]);
  const [batch, setBatch] = useState<BatchDTO | null>(null);
  const [dateInput, setDateInput] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [tiktokPrivacy, setTiktokPrivacy] = useState<string[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragItem, setDragItem] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  useDialogFocus(!!summary, () => {
    if (!busy) setSummary(null);
  });
  const [confirmKey, setConfirmKey] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ count: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<Map<string, Patch>>(new Map());
  const timer = useRef<number | undefined>(undefined);
  const batchRef = useRef<BatchDTO | null>(null);
  batchRef.current = batch;
  const creating = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [d, c] = await Promise.all([api.drafts(), api.connections()]);
        setDrafts(d);
        setConnections(c);
        if (d[0]) open(d[0]);
        if (c.find((x) => x.platform === 'tiktok')?.capabilities.includes('direct')) {
          api
            .creatorInfo()
            .then((i) => setTiktokPrivacy(i.privacy_level_options))
            .catch(() => setTiktokPrivacy(null));
        }
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (b: BatchDTO) => {
    setBatch(b);
    setDateInput(b.startDate);
    setDateError(null);
    setDone(null);
  };

  // ---------- gravação dos textos (debounce + envio garantido ao fechar a aba) ----------
  const flush = useCallback(async (keepalive = false) => {
    window.clearTimeout(timer.current);
    const b = batchRef.current;
    if (!b || pending.current.size === 0) return;
    const entries = [...pending.current.entries()];
    pending.current.clear();
    for (const [itemId, patch] of entries) {
      try {
        const nb = await api.patchItem(b.id, itemId, patch, keepalive);
        if (!keepalive)
          setBatch((cur) => (cur && cur.id === nb.id ? mergeKeepingTexts(cur, nb) : cur));
      } catch (e: any) {
        if (!keepalive) setError(`Não foi possível salvar o rascunho: ${e.message}`);
      }
    }
  }, []);

  useEffect(() => {
    const onHide = () => void flush(true);
    const onVis = () => document.visibilityState === 'hidden' && onHide();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [flush]);

  const queuePatch = (itemId: string, patch: Patch) => {
    const cur = pending.current.get(itemId) ?? {};
    const platforms = { ...(cur.platforms ?? {}) };
    for (const [p, v] of Object.entries(patch.platforms ?? {}))
      platforms[p as Platform] = { ...(platforms[p as Platform] ?? {}), ...v };
    pending.current.set(itemId, { ...cur, ...patch, platforms });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };

  // ---------- data inicial ----------
  const onDate = async (v: string) => {
    setDateInput(v);
    setDateError(null);
    if (v.length < 10) return;
    if (!isValidBrDate(v)) {
      setDateError('Data inválida. Use DD/MM/AAAA com uma data existente.');
      return;
    }
    try {
      if (!batch) {
        if (creating.current === v) return;
        creating.current = v;
        const b = await api.createBatch(v, idemKey());
        setDrafts((d) => [b, ...d]);
        open(b);
      } else if (v !== batch.startDate) {
        await flush();
        setBatch(await api.patchBatch(batch.id, { startDate: v }));
      }
    } catch (e: any) {
      setDateError(e.message);
    } finally {
      creating.current = null;
    }
  };

  // ---------- vídeos ----------
  const runUploads = async (b: BatchDTO, pairs: Array<{ itemId: string; file: File }>) => {
    const queue = [...pairs];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { itemId, file } = next;
        try {
          const target =
            b.items.find((i) => i.id === itemId)?.uploadUrl ??
            `/api/batches/${b.id}/items/${itemId}/video`;
          const nb = await uploadFile(target, file, (pct) =>
            setUploads((u) => ({ ...u, [itemId]: { ...u[itemId], pct, active: true } })),
          );
          setBatch((cur) => (cur ? mergeKeepingTexts(cur, nb) : nb));
          setUploads((u) => ({ ...u, [itemId]: { ...u[itemId], pct: 100, active: false } }));
        } catch (e: any) {
          setUploads((u) => ({
            ...u,
            [itemId]: { ...u[itemId], active: false, error: e.message },
          }));
          api
            .batch(b.id)
            .then((nb) => setBatch((cur) => (cur ? mergeKeepingTexts(cur, nb) : nb)))
            .catch(() => undefined);
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  };

  const addFiles = async (list: FileList | File[]) => {
    if (!batch) return;
    const files = Array.from(list); // ordem recebida pelo navegador
    if (files.length === 0) return;
    setError(null);
    try {
      const { batch: nb, itemIds } = await api.reserveItems(
        batch.id,
        files.map((f) => ({ name: f.name, size: f.size })),
      );
      const pairs = itemIds.map((itemId, i) => ({ itemId, file: files[i] }));
      setUploads((u) => {
        const next = { ...u };
        for (const { itemId, file } of pairs)
          next[itemId] = { pct: 0, active: true, objectUrl: URL.createObjectURL(file) };
        return next;
      });
      setBatch((cur) => (cur ? mergeKeepingTexts(cur, nb) : nb));
      await runUploads(nb, pairs);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const reorder = async (ids: string[]) => {
    if (!batch) return;
    await flush();
    // Atualização otimista; o servidor recalcula as datas.
    setBatch({ ...batch, items: ids.map((id) => batch.items.find((i) => i.id === id)!) });
    try {
      setBatch(await api.reorder(batch.id, ids));
    } catch (e: any) {
      setError(e.message);
      setBatch(await api.batch(batch.id));
    }
  };
  const move = (itemId: string, dir: -1 | 1) => {
    if (!batch) return;
    const ids = batch.items.map((i) => i.id);
    const i = ids.indexOf(itemId);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  };
  const dropOn = (targetId: string) => {
    if (!batch || !dragItem || dragItem === targetId) return;
    const ids = batch.items.map((i) => i.id).filter((id) => id !== dragItem);
    ids.splice(
      ids.indexOf(targetId) +
        (batch.items.findIndex((i) => i.id === dragItem) <
        batch.items.findIndex((i) => i.id === targetId)
          ? 1
          : 0),
      0,
      dragItem,
    );
    void reorder(ids);
  };

  const remove = async (itemId: string) => {
    if (
      !batch ||
      !confirm('Excluir este vídeo do lote? As datas dos seguintes serão recalculadas.')
    )
      return;
    await flush();
    pending.current.delete(itemId);
    try {
      setBatch(await api.deleteItem(batch.id, itemId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const setCover = async (itemId: string, file: File) => {
    if (!batch) return;
    try {
      const target =
        batch.items.find((i) => i.id === itemId)?.coverUploadUrl ??
        `/api/batches/${batch.id}/items/${itemId}/cover`;
      const nb = await uploadFile(target, file, () => undefined);
      setBatch((cur) => (cur ? mergeKeepingTexts(cur, nb) : nb));
    } catch (e: any) {
      setError(`Capa: ${e.message}`);
    }
  };

  const togglePlatform = async (p: Platform, v: boolean) => {
    if (!batch) return;
    try {
      setBatch(mergeKeepingTexts(batch, await api.patchBatch(batch.id, { platforms: { [p]: v } })));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ---------- resumo e confirmação ----------
  const review = async () => {
    if (!batch) return;
    await flush();
    try {
      setSummary(await api.summary(batch.id));
      setConfirmKey(idemKey()); // uma chave por abertura: clique duplo reaproveita
    } catch (e: any) {
      setError(e.message);
    }
  };
  const doConfirm = async () => {
    if (!batch || busy) return;
    setBusy(true);
    try {
      const r = await api.confirm(batch.id, confirmKey);
      setSummary(null);
      setDone({ count: r.tasks.length });
      setDrafts((d) => d.filter((x) => x.id !== batch.id));
      setBatch(null);
      setDateInput('');
      setUploads({});
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'in_progress') return;
      if (e instanceof ApiError && Array.isArray(e.details)) {
        setSummary((s) =>
          s
            ? {
                ...s,
                canConfirm: false,
                issues: [...e.details, ...s.issues.filter((i) => i.level !== 'error')],
              }
            : s,
        );
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async (b: BatchDTO) => {
    if (!confirm('Descartar este rascunho e os vídeos enviados?')) return;
    await api.deleteBatch(b.id);
    setDrafts((d) => d.filter((x) => x.id !== b.id));
    if (batch?.id === b.id) {
      setBatch(null);
      setDateInput('');
    }
  };

  const validDate = !!batch;
  const anyUploading = Object.values(uploads).some((u) => u.active);

  return (
    <div className="page">
      <div className="page-head advanced-heading">
        <span className="eyebrow">SEU ESTÚDIO DE CONTEÚDO</span>
        <h1>
          Novo lote<span className="accent-dot">.</span>
        </h1>
        <p className="muted">Prepare seus vídeos e mantenha cada plataforma no seu ritmo.</p>
        {drafts.length > 0 && (
          <div className="drafts">
            <span className="muted">Rascunhos salvos:</span>
            {drafts.map((d) => (
              <span key={d.id} className={batch?.id === d.id ? 'chip active' : 'chip'}>
                <button className="link" onClick={() => open(d)}>
                  {d.startDate} · {d.items.length} vídeo(s)
                </button>
                <button
                  className="link danger"
                  aria-label="Descartar rascunho"
                  onClick={() => discard(d)}
                >
                  ×
                </button>
              </span>
            ))}
            {batch && (
              <button
                className="small"
                onClick={() => {
                  setBatch(null);
                  setDateInput('');
                }}
              >
                + Começar outro
              </button>
            )}
          </div>
        )}
      </div>

      {done && (
        <div className="alert success">
          Lote registrado: {done.count} tarefa(s). Acompanhe em <a href="#/agenda">Agenda</a>.{' '}
          {!settings.backgroundWorker &&
            'Prepare os envios nativos na Agenda; as outras plataformas exigem publicação manual.'}
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}

      <div className="advanced-workspace">
        <div className="advanced-form">
          <section className="panel">
            <DateField
              label="Data inicial"
              value={dateInput}
              onChange={onDate}
              error={dateError}
              autoFocus={!batch}
              hint={`Um vídeo por dia às ${settings.publishTime} · ${settings.timezone === 'America/Sao_Paulo' ? 'Horário de Brasília' : settings.timezone}.`}
            />
            {batch && (
              <p className="saved-note">
                Rascunho salvo automaticamente no servidor — pode fechar a página e voltar depois.
              </p>
            )}
          </section>

          {validDate && batch && (
            <>
              <section className="panel">
                <h3>Redes do lote</h3>
                <div className="platform-toggles">
                  {PLATFORMS.map((p) => (
                    <label
                      key={p}
                      className={`platform-card ${p} ${batch.platforms[p] ? 'is-selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={batch.platforms[p]}
                        onChange={(e) => togglePlatform(p, e.target.checked)}
                      />
                      <span className="platform-avatar">
                        <Icon name={p} size={22} />
                      </span>
                      <span className="platform-name">
                        {PLATFORM_LABEL[p]}
                        <small>{connLabel(connections.find((c) => c.platform === p))}</small>
                      </span>
                      <span className="selection-check">
                        <Icon name="check" size={13} />
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section
                className={dragOver ? 'dropzone over' : 'dropzone'}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault();
                    setDragOver(true);
                  }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  if (!e.dataTransfer.files.length) return;
                  e.preventDefault();
                  setDragOver(false);
                  void addFiles(e.dataTransfer.files);
                }}
              >
                <p>
                  <strong>Arraste e solte um ou vários vídeos aqui</strong>
                  <br />
                  <span className="muted">
                    MP4 ou MOV. A ordem recebida vira a ordem inicial — reorganize depois se quiser.
                  </span>
                </p>
                <button className="primary" onClick={() => fileInput.current?.click()}>
                  <Icon name="plus" size={17} />
                  Selecionar arquivos
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="video/mp4,video/quicktime,.mp4,.mov"
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </section>

              {batch.items.length > 0 && (
                <section className="items">
                  <div className="items-head">
                    <h3>
                      Prévia ({batch.items.length} vídeo{batch.items.length > 1 ? 's' : ''})
                    </h3>
                    <span className="muted">
                      {batch.items[0].scheduledLocal} →{' '}
                      {batch.items[batch.items.length - 1].scheduledLocal}
                    </span>
                  </div>
                  {batch.items.map((it, i) => (
                    <VideoCard
                      key={it.id}
                      item={it}
                      index={i}
                      total={batch.items.length}
                      batchPlatforms={batch.platforms}
                      connections={connections}
                      upload={uploads[it.id]}
                      tiktokPrivacyOptions={tiktokPrivacy}
                      isDragOver={dropTarget === it.id && dragItem !== it.id}
                      dragProps={{
                        draggable: true,
                        onDragStart: (e) => {
                          setDragItem(it.id);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', it.id);
                        },
                        onDragOver: (e) => {
                          if (dragItem) {
                            e.preventDefault();
                            setDropTarget(it.id);
                          }
                        },
                        onDrop: (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          dropOn(it.id);
                          setDragItem(null);
                          setDropTarget(null);
                        },
                        onDragEnd: () => {
                          setDragItem(null);
                          setDropTarget(null);
                        },
                      }}
                      onTexts={(id, p, patch) => queuePatch(id, { platforms: { [p]: patch } })}
                      onFrame={(id, ms) => queuePatch(id, { coverFrameMs: ms })}
                      onMove={move}
                      onRemove={remove}
                      onCover={setCover}
                      onRemoveCover={async (id) =>
                        setBatch(mergeKeepingTexts(batch, await api.deleteCover(batch.id, id)))
                      }
                      onReupload={(id, file) => {
                        setUploads((u) => ({
                          ...u,
                          [id]: { pct: 0, active: true, objectUrl: URL.createObjectURL(file) },
                        }));
                        void runUploads(batch, [{ itemId: id, file }]);
                      }}
                    />
                  ))}
                  <div className="actions-bar">
                    <button className="primary big" onClick={review} disabled={anyUploading}>
                      {anyUploading ? 'Aguardando envios…' : 'Revisar e agendar'}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        <aside className="batch-preview advanced-preview">
          <div className="preview-top">
            <span className="eyebrow">REGISTROS DO SERVIDOR</span>
            <h2>
              Prévia do lote
              <Icon name="spark" size={19} />
            </h2>
          </div>
          <div className="preview-stats">
            <div>
              <strong>{batch?.items.length ?? 0}</strong>
              <span>vídeos</span>
            </div>
            <div>
              <strong>{batch ? PLATFORMS.filter((p) => batch.platforms[p]).length : 0}</strong>
              <span>plataformas</span>
            </div>
            <div>
              <strong>{settings.publishTime}</strong>
              <span>todos os dias</span>
            </div>
          </div>
          <div className="preview-schedule">
            <div className="list-label">
              <span>CONTEÚDO</span>
              <span>PUBLICAÇÃO</span>
            </div>
            {batch?.items.length ? (
              <ol className="schedule-lines">
                {batch.items.map((item) => (
                  <li key={item.id}>
                    <span className="timeline-dot" />
                    <div className="schedule-name">
                      <strong title={item.originalName}>{item.originalName}</strong>
                      <span>
                        {item.uploadStatus === 'ready'
                          ? 'Arquivo disponível'
                          : item.uploadStatus === 'uploading'
                            ? 'Enviando arquivo'
                            : item.uploadStatus === 'error'
                              ? 'Envio precisa de atenção'
                              : 'Aguardando arquivo'}
                      </span>
                    </div>
                    <div className="schedule-date">
                      <strong>{item.scheduledLocal.slice(0, 10)}</strong>
                      <span>{settings.publishTime}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="preview-empty">
                <Icon name="calendar" size={32} />
                <strong>Prepare seu próximo lote</strong>
                <p>Escolha a data inicial e adicione seus vídeos.</p>
              </div>
            )}
          </div>
          <div className="preview-save">
            <p>
              <Icon name="shield" size={14} />
              Rascunhos guardados no servidor.
            </p>
            <p>Confira as conexões e revise o lote antes de confirmar.</p>
          </div>
        </aside>
      </div>

      {summary && batch && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Resumo do agendamento"
        >
          <div className="modal wide">
            <h2>Resumo antes de agendar</h2>
            {settings.mode === 'demo' && (
              <div className="alert demo">Modo demonstração: as publicações serão simuladas.</div>
            )}
            <table className="summary-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Vídeo</th>
                  <th>Data e hora</th>
                  <th>Plataformas e contas</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.itemId}>
                    <td>{r.order}</td>
                    <td>{r.originalName}</td>
                    <td>{r.scheduledLocal}</td>
                    <td>
                      {r.platforms.length === 0 && <span className="muted">nenhuma</span>}
                      {r.platforms.map((p) => (
                        <div key={p.platform}>
                          <span className={`dot ${p.platform}`} /> {PLATFORM_LABEL[p.platform]} —{' '}
                          {p.account ?? <em className="err">sem conta</em>}{' '}
                          <small className="muted">({p.mode})</small>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.issues.length > 0 && (
              <ul className="issues">
                {summary.issues.map((i, k) => (
                  <li key={k} className={i.level}>
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button onClick={() => setSummary(null)} disabled={busy}>
                Voltar e editar
              </button>
              <button
                className="primary"
                onClick={doConfirm}
                disabled={!summary.canConfirm || busy}
              >
                {busy ? 'Registrando…' : 'Confirmar agendamento'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function connLabel(c?: ConnectionDTO): string {
  if (!c) return '';
  if (c.platform === 'tiktok' && c.capabilities.length === 1) return 'manual';
  if (c.needsReconnect) return 'reconectar';
  return c.connected ? (c.accountName ?? 'conectado') : 'não conectado';
}

/** Junta a resposta do servidor sem perder textos que ainda estão sendo digitados. */
function mergeKeepingTexts(cur: BatchDTO, next: BatchDTO): BatchDTO {
  return next.id === cur.id ? next : cur;
}
