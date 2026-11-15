import { publicationTexts, type PublicationTexts } from '../../../server/src/shared/publication';
import { validatePlatform } from '../../../server/src/shared/limits';
import { PublicationEditor } from './PublicationEditor';
import { useSession } from './AuthGate';
import { api } from '../lib/api';
import { manualOps } from '../lib/manual-agenda';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { PLATFORMS, PLATFORM_LABEL, type Platform } from '../../../server/src/shared/types';
import { brToIso, isoToBr, todayIsoSaoPaulo } from '../lib/date';
import {
  manualDates,
  markManualPlatform,
  readManualAgenda,
  saveManualAgenda,
  type ManualEntry,
} from '../lib/manual-agenda';
import { DateField } from './DateField';
import { Icon } from './ui/Icon';

export const PLATFORM_HOME: Record<Platform, string> = {
  youtube: 'https://studio.youtube.com/',
  facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  tiktok: 'https://www.tiktok.com/',
};
const PLATFORM_SUB: Record<Platform, string> = {
  facebook: 'Reels',
  youtube: 'Shorts',
  instagram: 'Reels',
  tiktok: 'Vídeos',
};
const PLATFORM_NAME: Record<Platform, string> = {
  facebook: 'Facebook',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};
const UPDATED = 'agendador-manual-updated';
export function ManualAgenda({ view = 'all' }: { view?: 'create' | 'agenda' | 'all' }) {
  const cloud = !!useSession();
  const editKey = `agendador:manual-text-edits:${useSession()?.id ?? 'local'}`;
  const restoreEdits = (list: ManualEntry[]) => {
    try {
      const edits = JSON.parse(window.localStorage.getItem(editKey) ?? '{}');
      return list.map(row => !edits[row.id] ? row : { ...row, textVersion: 2, texts: Object.fromEntries(PLATFORMS.map(p => [p, { ...publicationTexts(row)[p], ...edits[row.id][p] }])) as PublicationTexts });
    } catch { return list; }
  };
  const queue = useRef(Promise.resolve());
  const loadVersion = useRef(0);
  const persistedRows = useRef<ManualEntry[] | null>(null);
  const batchIdentity = useRef(crypto.randomUUID());
  const titleIdentity = useRef(crypto.randomUUID());
  const [loading, setLoading] = useState(cloud);
  const [initial] = useState(() => {
    try {
      return { rows: readManualAgenda(window.localStorage), error: '' };
    } catch {
      return {
        rows: [],
        error:
          'Não foi possível ler a agenda deste navegador. Nenhum dado foi apagado. Verifique o armazenamento e tente de novo.',
      };
    }
  });
  const [rows, setRows] = useState<ManualEntry[]>(cloud ? [] : restoreEdits(initial.rows)),
    [error, setError] = useState(cloud ? '' : initial.error),
    [blocked, setBlocked] = useState(cloud || !!initial.error);
  const [dateInput, setDateInput] = useState(() => isoToBr(todayIsoSaoPaulo())),
    [dateError, setDateError] = useState('');
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]),
    [platforms, setPlatforms] = useState<Platform[]>([...PLATFORMS]);
  const [selectedId, setSelectedId] = useState('');
  const [itemTexts, setItemTexts] = useState<Record<string, PublicationTexts>>({});
  const [draftReady, setDraftReady] = useState(false);
  const draftKey = `agendador:publication-draft:${useSession()?.id ?? 'local'}`;
  useEffect(() => {
    try { const raw = window.localStorage.getItem(draftKey); if (raw) { const d = JSON.parse(raw); setFiles(d.files ?? []); setItemTexts(d.itemTexts ?? {}); setPlatforms(d.platforms ?? [...PLATFORMS]); setDateInput(d.dateInput ?? isoToBr(todayIsoSaoPaulo())); setTitle(d.title ?? ''); if (d.batchId) batchIdentity.current = d.batchId; if (d.titleId) titleIdentity.current = d.titleId; } } catch { setError('Não foi possível recuperar o rascunho.'); }
    setDraftReady(true);
  }, [draftKey]);
  useEffect(() => { if (draftReady) { try { window.localStorage.setItem(draftKey, JSON.stringify({ files, itemTexts, platforms, dateInput, title, titleId: titleIdentity.current, batchId: batchIdentity.current })); } catch { setError('Não foi possível guardar o rascunho neste navegador.'); } } }, [files, itemTexts, platforms, dateInput, title, draftReady, draftKey]);
  const [info, setInfo] = useState(''),
    [over, setOver] = useState(false),
    [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('all'),
    [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null),
    dragDepth = useRef(0),
    formId = useId();
  const reload = () => {
    if (cloud) {
      const version = ++loadVersion.current;
      setLoading(true);
      void api
        .manual()
        .then(({ rows }) => {
          if (version !== loadVersion.current) return;
          persistedRows.current = rows;
          setRows(restoreEdits(rows));
          setError('');
          setBlocked(false);
        })
        .catch((e) => {
          if (version === loadVersion.current) {
            setError(e.message);
            setBlocked(true);
          }
        })
        .finally(() => {
          if (version === loadVersion.current) setLoading(false);
        });
      return;
    }
    try {
      const loaded = readManualAgenda(window.localStorage);
      persistedRows.current = loaded;
      setRows(restoreEdits(loaded));
      setError('');
      setBlocked(false);
    } catch {
      setError('A agenda continua indisponível neste navegador. Seus dados não foram apagados.');
    }
  };
  useEffect(() => {
    if (cloud) reload();
    window.addEventListener('storage', reload);
    window.addEventListener(UPDATED, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(UPDATED, reload);
    };
  }, []);
  useEffect(() => {
    if (!info) return;
    const timer = window.setTimeout(() => setInfo(''), 6500);
    return () => window.clearTimeout(timer);
  }, [info]);
  const save = async (next: ManualEntry[]) => {
    const changed = next.filter(row => JSON.stringify(row) !== JSON.stringify((persistedRows.current ?? initial.rows).find(x => x.id === row.id)));
    const invalid = changed.flatMap(row => PLATFORMS.filter(p => row.platforms[p] !== undefined).flatMap(p => validatePlatform(p, { ...publicationTexts(row)[p], madeForKids: false }, undefined).filter(i => i.level === 'error').map(i => `${row.originalName}: ${i.message}`)));
    if (invalid.length) { setError(invalid.join(' ')); return false; }
    if (cloud) {
      if (blocked) {
        setError('Recarregue a agenda antes de salvar.');
        return false;
      }
      const ops = manualOps(persistedRows.current ?? rows, next);
      let success = false;
      setSaving(true);
      ++loadVersion.current;
      const task = queue.current.then(async () => {
        try {
          let result: { rows: ManualEntry[] } | undefined;
          for (let i = 0; i < ops.length; i += 100)
            result = await api.saveManual(ops.slice(i, i + 100));
          if (result) { persistedRows.current = result.rows; setRows(result.rows); }
          try { window.localStorage.removeItem(editKey); } catch {}
          setError('');
          success = true;
          window.dispatchEvent(new Event(UPDATED));
        } catch (e: any) {
          setError(e.message);
        } finally {
          setSaving(false);
        }
      });
      queue.current = task.catch(() => {});
      await task;
      return success;
    }
    if (blocked) {
      setError(initial.error || 'O armazenamento deste navegador está bloqueado. Tente de novo.');
      return false;
    }
    try {
      if (JSON.stringify(readManualAgenda(window.localStorage)) !== JSON.stringify(persistedRows.current ?? initial.rows)) {
        setError('A agenda mudou em outra aba. Clique em Tentar de novo antes de salvar.');
        return false;
      }
      saveManualAgenda(window.localStorage, next);
      try { window.localStorage.removeItem(editKey); } catch {}
      persistedRows.current = next;
      setRows(next);
      setError('');
      window.dispatchEvent(new Event(UPDATED));
      return true;
    } catch {
      setError(
        'Não foi possível salvar. Libere espaço ou habilite o armazenamento deste navegador; seus registros anteriores foram preservados.',
      );
      return false;
    }
  };
  const addFiles = (list: FileList | File[]) => {
    const selected = Array.from(list).filter(
      (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name),
    );
    if (!selected.length) {
      setError('Selecione arquivos de vídeo. No modo manual, somente os nomes são registrados.');
      return;
    }
    setFiles((previous) => [
      ...previous,
      ...selected.map((f) => ({ id: crypto.randomUUID(), name: f.name })),
    ]);
    setError('');
  };
  const names = files.length
    ? files
    : title.trim()
      ? [{ id: titleIdentity.current, name: title.trim() }]
      : [];
  let dates: string[] = [];
  try {
    dates = manualDates(brToIso(dateInput), names.length);
  } catch {}
  const activeFile = names.find(f => f.id === selectedId) ?? names[0];
  const textsFor = (file: { id: string; name: string }) => itemTexts[file.id] ?? publicationTexts({ title: file.name.replace(/\.[^.]+$/, ''), description });
  const complete = (r: ManualEntry) => Object.values(r.platforms).every(Boolean);
  const completed = rows.filter(complete).length;
  const shown = [...rows]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter(
      (r) =>
        (filter === 'all' || (filter === 'done' ? complete(r) : !complete(r))) &&
        `${r.title} ${r.originalName}`
          .toLocaleLowerCase('pt-BR')
          .includes(search.toLocaleLowerCase('pt-BR')),
    );
  const exportAgenda = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agenda-manual.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className={`manual-workspace view-${view}`}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SEU ESTÚDIO DE CONTEÚDO</span>
          <h1>
            {view === 'agenda' ? 'Sua agenda' : 'Novo lote'}
            <span className="accent-dot">.</span>
          </h1>
          <p>
            {view === 'agenda'
              ? 'Tudo no seu tempo. Um vídeo de cada vez.'
              : 'Organize suas ideias. Dê ritmo às suas publicações.'}
          </p>
        </div>
        <span className="context-badge">
          <span className="status-dot" />
          Agenda manual
        </span>
      </div>
      {loading && <p role="status">Carregando agenda do Supabase…</p>}
      {cloud && initial.rows.length > 0 && (
        <div className="work-panel">
          <p>
            Há {initial.rows.length} registro(s) antigo(s) neste navegador. A cópia local será
            preservada.
          </p>
          <button
            disabled={loading || saving || blocked}
            onClick={async () => {
              setSaving(true);
              try {
                for (let i = 0; i < initial.rows.length; i += 100)
                  await api.saveManual(
                    initial.rows.slice(i, i + 100).map((value) => ({ type: 'insert', value })),
                  );
                setInfo('Importação concluída. IDs repetidos foram ignorados.');
                reload();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setSaving(false);
              }
            }}
          >
            Importar registros antigos sem duplicar
          </button>
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          <Icon name="info" />
          <span>{error}</span>
          <button onClick={reload}>Tentar de novo</button>
        </div>
      )}
      {info && (
        <div className="toast success" role="status">
          <Icon name="check" />
          <span>{info}</span>
          {view !== 'agenda' && (
            <a href="#/agenda">
              Abrir Agenda <Icon name="arrow" size={14} />
            </a>
          )}
        </div>
      )}
      {view !== 'agenda' && (
        <div className="batch-workspace">
          <form
            id={formId}
            className="batch-form"
            inert={saving}
            onSubmit={async (e) => {
              e.preventDefault();
              setInfo('');
              setDateError('');
              if (!brToIso(dateInput)) {
                setDateError('Informe uma data válida em DD/MM/AAAA.');
                return;
              }
              if ((!title.trim() && !files.length) || !platforms.length) {
                setError(
                  'Informe um título ou escolha vídeos e selecione pelo menos uma plataforma.',
                );
                return;
              }
              setSaving(true);
              try {
                const invalid = names.flatMap(file => platforms.flatMap(p => validatePlatform(p, { ...textsFor(file)[p], madeForKids: false }, undefined).filter(i => i.level === 'error').map(i => `${file.name}: ${i.message}`)));
                if (invalid.length) { setError(invalid.join(' ')); return; }
                const batchId = batchIdentity.current;
                const added: ManualEntry[] = names.map((file, i) => ({
                  batchId,
                  id: file.id,
                  date: dates[i],
                  originalName: file.name,
                  title: title.trim() || file.name,
                  description: '',
                  textVersion: 2,
                  texts: textsFor(file),
                  platforms: Object.fromEntries(platforms.map((p) => [p, false])),
                }));
                if (await save([...rows, ...added])) {
                  batchIdentity.current = crypto.randomUUID();
                  titleIdentity.current = crypto.randomUUID();
                  setTitle('');
                  setDescription('');
                  setFiles([]);
                  setItemTexts({});
                  setInfo(
                    `${added.length} registro(s) salvo(s) ${cloud ? 'no Supabase' : 'neste navegador'}.`,
                  );
                }
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : 'Não foi possível criar os registros.',
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            <section className="work-panel date-panel">
              <div className="section-heading">
                <span className="step-number">01</span>
                <h2>Quando começamos?</h2>
                <Icon name="calendar" />
              </div>
              <div className="date-layout">
                <DateField
                  label="Data inicial"
                  value={dateInput}
                  onChange={(value) => {
                    setDateInput(value);
                    setDateError('');
                  }}
                  error={dateError}
                  minDate={false}
                  hint="DD/MM/AAAA"
                />
                <div className="schedule-rule">
                  <span className="rule-icon">
                    <Icon name="clock" />
                  </span>
                  <div>
                    <strong>Um vídeo por dia às 12:00</strong>
                    <span>Horário de Brasília · inclui fins de semana</span>
                  </div>
                </div>
              </div>
            </section>
            <section className="work-panel">
              <div className="section-heading">
                <span className="step-number">02</span>
                <h2>Adicione seu conteúdo</h2>
                <span className="optional-label">VÍDEOS</span>
              </div>
              <div
                className={`file-drop ${over ? 'is-over' : ''}`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  dragDepth.current++;
                  setOver(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  if (--dragDepth.current <= 0) setOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dragDepth.current = 0;
                  setOver(false);
                  addFiles(e.dataTransfer.files);
                }}
              >
                <span className="upload-orb">
                  <Icon name="upload" size={25} />
                </span>
                <h3>Adicionar vídeos</h3>
                <p>Arraste seus arquivos até aqui ou selecione no dispositivo.</p>
                <button type="button" onClick={() => fileInput.current?.click()}>
                  <Icon name="plus" size={17} />
                  Selecionar arquivos
                </button>
                <input
                  ref={fileInput}
                  className="sr-only"
                  type="file"
                  multiple
                  accept="video/*"
                  aria-label="Selecionar arquivos de vídeo"
                  tabIndex={-1}
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
              <p className="field-hint file-note">
                <Icon name="info" size={14} />
                No modo manual, só os nomes são registrados. Nenhum upload é realizado.
              </p>
              {files.length > 0 && (
                <ol className="selected-files">
                  {files.map((file, index) => (
                    <li key={file.id} aria-current={activeFile?.id === file.id}>
                      <span className="file-number">{String(index + 1).padStart(2, '0')}</span>
                      <Icon name="video" size={17} />
                      <button type="button" className="filename link" onClick={() => setSelectedId(file.id)}>{file.name}</button>
                      <div className="file-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Mover ${file.name} para cima`}
                          disabled={index === 0}
                          onClick={() =>
                            setFiles((items) => {
                              const next = [...items];
                              [next[index - 1], next[index]] = [next[index], next[index - 1]];
                              return next;
                            })
                          }
                        >
                          <Icon name="chevron" size={15} style={{ transform: 'rotate(180deg)' }} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Mover ${file.name} para baixo`}
                          disabled={index === files.length - 1}
                          onClick={() =>
                            setFiles((items) => {
                              const next = [...items];
                              [next[index], next[index + 1]] = [next[index + 1], next[index]];
                              return next;
                            })
                          }
                        >
                          <Icon name="chevron" size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remover ${file.name}`}
                          onClick={() => setFiles((items) => items.filter((f) => f.id !== file.id))}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {!files.length && <label className="field">Nome do vídeo<input aria-label="Nome do vídeo" value={title} onChange={e => setTitle(e.target.value)} placeholder="Ou crie um registro sem arquivo" /></label>}
              {activeFile && <PublicationEditor key={activeFile.id} name={activeFile.name} platforms={platforms} texts={textsFor(activeFile)} onChange={(p, patch) => setItemTexts(current => { const base = current[activeFile.id] ?? textsFor(activeFile); return { ...current, [activeFile.id]: { ...base, [p]: { ...base[p], ...patch } } }; })} />}

            </section>
            <section className="work-panel">
              <div className="section-heading">
                <span className="step-number">03</span>
                <h2>Onde vamos publicar?</h2>
                <span className="optional-label">{platforms.length} DE 4</span>
              </div>
              <fieldset className="platform-cards">
                <legend className="sr-only">Plataformas do lote</legend>
                {PLATFORMS.map((p) => (
                  <label
                    key={p}
                    className={`platform-card ${p} ${platforms.includes(p) ? 'is-selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={platforms.includes(p)}
                      onChange={(e) =>
                        setPlatforms((ps) =>
                          e.target.checked ? [...ps, p] : ps.filter((x) => x !== p),
                        )
                      }
                    />
                    <span className="platform-avatar">
                      <Icon name={p} size={22} />
                    </span>
                    <span className="platform-name">
                      {PLATFORM_NAME[p]}
                      <small>{PLATFORM_SUB[p]}</small>
                    </span>
                    <span className="selection-check">
                      <Icon name="check" size={13} />
                    </span>
                  </label>
                ))}
              </fieldset>
            </section>
          </form>
          <aside className="batch-preview">
            <div className="preview-top">
              <span className="eyebrow">TUDO PRONTO PARA O PRÓXIMO PASSO</span>
              <h2>
                Prévia do lote <Icon name="spark" size={19} />
              </h2>
            </div>
            <div className="preview-stats">
              <div>
                <strong>{String(names.length).padStart(2, '0')}</strong>
                <span>vídeo{names.length !== 1 ? 's' : ''}</span>
              </div>
              <div>
                <strong>{platforms.length}</strong>
                <span>plataforma{platforms.length !== 1 ? 's' : ''}</span>
              </div>
              <div>
                <strong>12:00</strong>
                <span>todos os dias</span>
              </div>
            </div>
            <div className="preview-platforms">
              {platforms.length ? (
                PLATFORMS.filter((p) => platforms.includes(p)).map((p) => (
                  <span className={`mini-platform ${p}`} key={p} title={PLATFORM_LABEL[p]}>
                    <Icon name={p} size={16} />
                  </span>
                ))
              ) : (
                <span className="field-hint">Selecione pelo menos uma plataforma.</span>
              )}
              <span className="preview-timezone">Brasília · UTC−3</span>
            </div>
            <div className="preview-schedule">
              <div className="list-label">
                <span>CONTEÚDO</span>
                <span>PUBLICAÇÃO</span>
              </div>
              {!names.length || !dates.length ? (
                <div className="preview-empty">
                  <Icon name="calendar" size={32} />
                  <strong>Seu próximo conteúdo começa aqui</strong>
                  <p>
                    {!dates.length && names.length
                      ? 'Escolha uma data inicial válida.'
                      : 'Adicione vídeos ou um título para visualizar seu lote.'}
                  </p>
                  <div className="preview-ghost">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              ) : (
                <ol className="schedule-lines">
                  {names.map((file, i) => (
                    <li key={file.id} aria-current={activeFile?.id === file.id}>
                      <span className="timeline-dot" />
                      <div className="schedule-name">
                        <strong title={file.name}>{title.trim() || file.name}</strong>
                        <span>{file.name}</span>
                      </div>
                      <div className="schedule-date">
                        <strong>{isoToBr(dates[i])}</strong>
                        <span>12:00</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="preview-save">
              <button
                className="primary save-batch"
                type="submit"
                form={formId}
                disabled={saving || blocked || loading}
              >
                <Icon name={saving ? 'clock' : 'calendar'} />
                <span>{saving ? 'Salvando…' : 'Salvar na agenda manual'}</span>
                <Icon name="arrow" size={17} />
              </button>
              <p>
                <Icon name="shield" size={13} />
                {cloud
                  ? 'Registros salvos na sua conta, no Supabase.'
                  : 'Registros salvos apenas neste navegador.'}
              </p>
              <details className="local-details">
                <summary>
                  Como funciona a agenda manual?
                  <Icon name="chevron" size={14} />
                </summary>
                <p>
                  {cloud
                    ? 'Os registros ficam na sua conta, no Supabase.'
                    : 'Os registros ficam apenas neste navegador.'}{' '}
                  Vídeos e capas não são enviados nem guardados aqui. Não há publicação automática,
                  lembrete em segundo plano ou sincronização entre dispositivos. Guarde seus
                  arquivos e exporte uma cópia da agenda.
                </p>
              </details>
            </div>
          </aside>
        </div>
      )}
      {view !== 'create' && (
        <section className="manual-records" aria-label="Registros da agenda manual">
          <div className="agenda-toolbar">
            <div
              className="segmented"
              style={{ '--segment': ['all', 'pending', 'done'].indexOf(filter) } as CSSProperties}
              aria-label="Filtrar agenda"
            >
              {(['all', 'pending', 'done'] as const).map((value, i) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  className={filter === value ? 'active' : ''}
                  onClick={() => setFilter(value)}
                >
                  {['Todos', 'Pendentes', 'Concluídos'][i]}
                  <span>
                    {value === 'all'
                      ? rows.length
                      : value === 'done'
                        ? completed
                        : rows.length - completed}
                  </span>
                </button>
              ))}
            </div>
            <div className="agenda-tools">
              <label className="search-field">
                <Icon name="search" size={17} />
                <input
                  aria-label="Buscar vídeos na agenda"
                  placeholder="Buscar conteúdo…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <button disabled={!rows.length} onClick={exportAgenda}>
                <Icon name="download" size={17} />
                <span>Exportar agenda</span>
              </button>
              <a className="button primary" href="#/novo">
                <Icon name="plus" size={17} />
                Novo lote
              </a>
            </div>
          </div>
          {!shown.length && (
            <div className="agenda-empty">
              <span className="empty-illustration">
                <Icon name={rows.length ? 'search' : 'calendar'} size={35} />
                <i />
              </span>
              <h2>
                {rows.length ? 'Nenhum resultado por aqui' : 'Espaço para suas próximas ideias'}
              </h2>
              <p>
                {rows.length
                  ? 'Tente outra busca ou ajuste os filtros da agenda.'
                  : 'Crie seu primeiro lote. Um vídeo por dia, no seu ritmo.'}
              </p>
              {rows.length ? (
                <button
                  onClick={() => {
                    setFilter('all');
                    setSearch('');
                  }}
                >
                  Limpar filtros
                </button>
              ) : (
                <a href="#/novo" className="button">
                  <Icon name="plus" size={17} />
                  Criar primeiro lote
                </a>
              )}
            </div>
          )}
          {shown.map((r, index) => (
            <div className="agenda-entry" key={r.id}>
              {(index === 0 || shown[index - 1].date !== r.date) && (
                <div className="day-heading">
                  <span>{isoToBr(r.date)}</span>
                  <small>12:00 · Horário de Brasília</small>
                  <i />
                </div>
              )}
              <article className={`agenda-card ${complete(r) ? 'is-complete' : ''}`}>
                <div className="agenda-card-head">
                  <span className="video-tile">
                    <Icon name="play" size={23} />
                  </span>
                  <div className="agenda-video-title">
                    <h3>{r.title}</h3>
                    <p title={r.originalName}>{r.originalName}</p>
                  </div>
                  <span className={`badge ${complete(r) ? 'st-published' : 'st-manual_action'}`}>
                    <Icon name={complete(r) ? 'check' : 'clock'} size={13} />
                    {complete(r) ? 'Concluído manualmente' : 'Publicação manual pendente'}
                  </span>
                </div>
                <div className="platform-statuses">
                  {PLATFORMS.filter((p) => r.platforms[p] !== undefined).map((p) => (
                    <div className={`platform-status ${r.platforms[p] ? 'done' : ''}`} key={p}>
                      <span className={`platform-avatar ${p}`}>
                        <Icon name={p} size={18} />
                      </span>
                      <span className="status-platform-name">
                        {PLATFORM_LABEL[p]}
                        <small>{r.platforms[p] ? 'Concluído manualmente' : 'Pendente'}</small>
                      </span>
                      <a
                        className="icon-button"
                        aria-label={`Abrir ${PLATFORM_NAME[p]}`}
                        href={PLATFORM_HOME[p]}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon name="arrow" size={16} style={{ transform: 'rotate(-40deg)' }} />
                      </a>
                      <button
                        disabled={saving || blocked || loading}
                        className={`completion-button ${r.platforms[p] ? 'is-done' : ''}`}
                        aria-label={`${r.platforms[p] ? 'Marcar pendente' : 'Registrar conclusão'} em ${PLATFORM_NAME[p]} para ${r.title}`}
                        title={r.platforms[p] ? 'Marcar pendente' : 'Registrar conclusão'}
                        onClick={() => save(markManualPlatform(rows, r.id, p))}
                      >
                        <Icon name="check" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                <details className="entry-details">
                  <summary>
                    <span>
                      <Icon name="copy" size={15} />
                      Descrição e ações
                    </span>
                    <Icon name="chevron" size={16} />
                  </summary>
                  <div>
                    <PublicationEditor disabled={saving || blocked || loading} name={r.originalName} platforms={PLATFORMS.filter(p => r.platforms[p] !== undefined)} texts={publicationTexts(r)} onChange={(p, patch) => {
                      try {
                        const edits = JSON.parse(window.localStorage.getItem(editKey) ?? '{}');
                        edits[r.id] = { ...edits[r.id], [p]: { ...edits[r.id]?.[p], ...patch } };
                        window.localStorage.setItem(editKey, JSON.stringify(edits));
                      } catch { setError('Não foi possível guardar as alterações locais. Salve os textos antes de sair.'); }
                      setRows(current => current.map(x => x.id === r.id ? { ...x, textVersion: 2, texts: { ...publicationTexts(x), [p]: { ...publicationTexts(x)[p], ...patch } } } : x));
                    }} />
                    <p className="field-hint">Alterações recuperadas neste navegador. Use Salvar textos para atualizar a agenda{cloud ? ' no Supabase' : ''}.</p>
                    <div className="row">
                      <button disabled={saving || blocked || loading} onClick={() => save(rows)}>Salvar textos</button>
                      <button
                        className="small danger"
                        onClick={() => {
                          if (confirm('Excluir este registro da agenda manual?'))
                            save(rows.filter((x) => x.id !== r.id));
                        }}
                      >
                        <Icon name="trash" size={15} />
                        Excluir registro
                      </button>
                    </div>
                  </div>
                </details>
              </article>
            </div>
          ))}
          <p className="agenda-local-note">
            <Icon name="shield" size={14} />
            {cloud
              ? 'Esta agenda fica na sua conta, no Supabase.'
              : 'Esta agenda fica neste navegador.'}{' '}
            Exporte os registros para manter uma cópia.
          </p>
        </section>
      )}
    </div>
  );
}
