import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Platform, PostRecord } from '../../../server/src/shared/types';
import { RULES } from '../../../server/src/shared/limits';
import { buildGroups, filesFromDrop, filesFromInput, type ImportGroup } from '../lib/folder-import';
import { directApi, uploadFacebook, uploadInstagram, uploadYouTube } from '../lib/direct-upload';
import { Icon } from './ui/Icon';
import '../post.css';

type Net = 'youtube' | 'facebook' | 'instagram';
const NETS: Array<{ id: Net; label: string; kind: string }> = [
  { id: 'youtube', label: 'YouTube', kind: 'agendado na data' },
  { id: 'facebook', label: 'Facebook', kind: 'agendado na data' },
  { id: 'instagram', label: 'Instagram', kind: 'publica na hora do envio' },
];
const NET_LABEL: Record<Platform, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };

type Phase = 'waiting' | 'sending' | 'processing' | 'scheduled' | 'published' | 'failed' | 'skipped';
interface NetState { phase: Phase; sent: number; step?: string; error?: string; url?: string; note?: string }
interface Row extends ImportGroup {
  key: string;
  videoUrl: string;
  coverUrl?: string;
  duration?: number;
  dims?: string;
  texts: Record<Net, { title: string; description: string }>;
  state: Partial<Record<Net, NetState>>;
  /** Envios anteriores deste mesmo vídeo (histórico). */
  posted?: PostRecord[];
}
interface LogLine { at: Date; text: string; level: 'info' | 'ok' | 'error' }

const fileKey = (f: File) => `${f.name}|${f.size}`;
const norm = (t?: string) => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();

/** Miniatura 9:16 pequena da capa (ou de um quadro do vídeo) para o histórico. */
async function makeThumb(src: string, isVideo: boolean): Promise<string | undefined> {
  try {
    const el: HTMLImageElement | HTMLVideoElement = isVideo ? document.createElement('video') : new Image();
    await new Promise<void>((ok, fail) => {
      if (el instanceof HTMLVideoElement) { el.muted = true; el.preload = 'auto'; el.onloadeddata = () => { el.currentTime = Math.min(1, el.duration / 2); }; el.onseeked = () => ok(); }
      else el.onload = () => ok();
      el.onerror = () => fail(new Error('thumb'));
      el.src = src;
    });
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    const c = document.createElement('canvas'); c.width = 108; c.height = 192;
    const scale = Math.max(c.width / w, c.height / h);
    c.getContext('2d')!.drawImage(el, (c.width - w * scale) / 2, (c.height - h * scale) / 2, w * scale, h * scale);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return undefined; }
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const fmtDate = (d: Date) => d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m < 60 ? `${m} min ${pad(s)} s` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return localInput(d);
}

function toRow(g: ImportGroup, i: number): Row {
  const base = g.video.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const yt = g.texts?.youtube;
  return {
    ...g,
    key: `${Date.now()}-${i}-${g.video.name}`,
    videoUrl: URL.createObjectURL(g.video),
    coverUrl: g.cover ? URL.createObjectURL(g.cover) : undefined,
    texts: {
      youtube: { title: yt?.title ?? base, description: yt?.description ?? '' },
      facebook: { title: g.texts?.facebook?.title ?? yt?.title ?? base, description: g.texts?.facebook?.description ?? '' },
      instagram: { title: '', description: g.texts?.instagram?.description ?? '' },
    },
    state: {},
  };
}

const PHASE_LABEL: Record<Phase, string> = {
  waiting: 'Na fila', sending: 'Enviando', processing: 'Processando', scheduled: 'Agendado ✅',
  published: 'Publicado ✅', failed: 'Falhou ❌', skipped: 'Não enviado',
};

export function DirectPost() {
  const [rows, setRows] = useState<Row[]>([]);
  const [nets, setNets] = useState<Record<Net, boolean>>({ youtube: true, facebook: true, instagram: true });
  const [start, setStart] = useState(defaultStart);
  const [everyDays, setEveryDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', warn); };
  }, [busy]);

  const [notice, setNotice] = useState<string[]>([]);
  const add = async (groups: ImportGroup[]) => {
    if (!groups.length) return setError('Nenhum vídeo MP4/MOV encontrado no que foi solto.');
    setError(null);
    let history: PostRecord[] = [];
    try { history = await directApi.posts(); } catch {}
    const msgs: string[] = [];
    const inDraft = new Set(rows.map((r) => fileKey(r.video)));
    const fresh: Row[] = [];
    groups.forEach((g, i) => {
      const k = fileKey(g.video);
      if (inDraft.has(k)) { msgs.push(`"${g.name}" já está no rascunho — não foi adicionado de novo.`); return; }
      inDraft.add(k);
      const row = toRow(g, rows.length + i);
      const titles = [row.texts.youtube.title, row.texts.facebook.title].map(norm).filter(Boolean);
      const raw = ` ${norm(g.rawText)} `;
      const sameTitle = (t?: string) => { const n = norm(t); return !!n && n.length > 8 && (titles.includes(n) || raw.includes(` ${n} `)); };
      const posted = history.filter((p) => p.status !== 'failed' && (p.fileKey === k || norm(p.video) === norm(g.name) || sameTitle(p.title)));
      if (posted.length) {
        row.posted = posted;
        msgs.push(`"${g.name}" já foi ${posted.map((p) => `${p.status === 'scheduled' ? 'programado' : p.status === 'published' ? 'postado' : 'enviado'} no ${NET_LABEL[p.platform]}${p.publishAt ? ` (${fmtDate(new Date(p.publishAt))})` : ''}`).join(', ')}.`);
      }
      fresh.push(row);
    });
    setNotice(msgs);
    setRows((r) => [...r, ...fresh]);
  };
  const dateFor = (i: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i * everyDays);
    return d;
  };
  const patchRow = (key: string, fn: (r: Row) => Row) => setRows((r) => r.map((x) => (x.key === key ? fn(x) : x)));
  const setNet = (key: string, net: Net, p: Partial<NetState>) =>
    patchRow(key, (x) => ({ ...x, state: { ...x.state, [net]: { phase: 'waiting', sent: 0, ...x.state[net], ...p } } }));
  const say = (text: string, level: LogLine['level'] = 'info') => setLog((l) => [...l, { at: new Date(), text, level }]);
  const move = (i: number, d: -1 | 1) => setRows((r) => {
    const j = i + d; if (j < 0 || j >= r.length) return r;
    const c = [...r]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  // Total de bytes a enviar: cada vídeo vai uma vez ao YouTube e uma vez ao Facebook
  // (o Instagram reaproveita o envio do Facebook).
  const uploadsPerVideo = (nets.youtube ? 1 : 0) + (nets.facebook ? 1 : 0) + (nets.instagram ? 1 : 0);
  const totalBytes = rows.reduce((s, r) => s + r.video.size * uploadsPerVideo, 0);
  const sentBytes = rows.reduce((s, r) => s + Math.min(r.state.youtube?.sent ?? 0, r.video.size)
    + Math.min(r.state.facebook?.sent ?? 0, r.video.size) + Math.min(r.state.instagram?.sent ?? 0, r.video.size), 0);
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0;
  const speed = elapsed > 2 ? sentBytes / elapsed : 0;
  const eta = speed > 0 ? (totalBytes - sentBytes) / speed : NaN;
  const pct = totalBytes ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0;
  const counts = useMemo(() => {
    const c = { ok: 0, failed: 0, total: 0 };
    for (const r of rows) for (const n of NETS) if (nets[n.id]) {
      c.total++;
      const ph = r.state[n.id]?.phase;
      if (ph === 'scheduled' || ph === 'published') c.ok++;
      if (ph === 'failed') c.failed++;
    }
    return c;
  }, [rows, nets]);

  const run = async () => {
    setError(null);
    if (!rows.length) return setError('Adicione pelo menos um vídeo.');
    if (!nets.youtube && !nets.facebook && !nets.instagram) return setError('Escolha pelo menos uma rede.');
    const repeated = rows.filter((r) => r.posted?.length);
    if (repeated.length && !confirm(`${repeated.length} vídeo(s) já foram programados ou postados antes:\n\n${repeated.map((r) => `• ${r.name}`).join('\n')}\n\nPostar de novo mesmo assim? (Cancelar para revisar; use Excluir nos cartões marcados.)`)) return;
    const missing = rows.find((r) => nets.youtube && !r.texts.youtube.title.trim());
    if (missing) return setError(`"${missing.name}": o YouTube exige título.`);
    setBusy(true);
    setLog([]);
    setStartedAt(Date.now());
    for (const r of rows) setRows((x) => x.map((y) => (y.key === r.key ? { ...y, state: Object.fromEntries(NETS.filter((n) => nets[n.id]).map((n) => [n.id, { phase: 'waiting', sent: 0 }])) } : y)));
    try {
      say('Conferindo as contas conectadas…');
      const s = await directApi.session();
      for (const n of NETS) if (nets[n.id] && s.errors[n.id]) throw new Error(`${n.label}: ${s.errors[n.id]}`);
      say(`Contas ok${s.facebook ? ` · Página "${s.facebook.pageName}"` : ''}${s.instagram ? ` · Instagram @${s.instagram.username}` : ''}.`, 'ok');

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const when = dateFor(i);
        const tag = `[${i + 1}/${rows.length}] ${row.name}`;
        const thumb = await makeThumb(row.coverUrl ?? row.videoUrl, !row.coverUrl);
        const record = (platform: Platform, status: PostRecord['status'], extra: Partial<PostRecord> = {}) =>
          directApi.savePost({ id: `${platform}-${row.key}`, platform, status, video: row.name, fileKey: fileKey(row.video), thumb, publishAt: when.toISOString(), ...extra })
            .catch((e) => say(`Aviso: não salvei no histórico (${e.message}).`, 'error'));

        if (nets.youtube) {
          const t = row.texts.youtube;
          try {
            say(`${tag} → YouTube: começando (${mb(row.video.size)}).`);
            setNet(row.key, 'youtube', { phase: 'sending', step: 'Iniciando…' });
            await record('youtube', 'sending', { title: t.title });
            const r = await uploadYouTube(s, row.video, row.cover, { title: t.title, description: t.description, publishAt: when },
              (sent) => setNet(row.key, 'youtube', { sent }), (step) => setNet(row.key, 'youtube', { step }));
            const scheduled = when.getTime() > Date.now() + 60_000;
            setNet(row.key, 'youtube', { phase: scheduled ? 'scheduled' : 'published', sent: row.video.size, step: undefined, url: r.url, note: r.note });
            say(`${tag} → YouTube: ${scheduled ? `agendado para ${fmtDate(when)}` : 'publicado'}.${r.note ? ` ${r.note}` : ''}`, 'ok');
            await record('youtube', scheduled ? 'scheduled' : 'published', { remoteId: r.id, url: r.url });
          } catch (e: any) {
            setNet(row.key, 'youtube', { phase: 'failed', error: e.message, step: undefined });
            say(`${tag} → YouTube falhou: ${e.message}`, 'error');
            await record('youtube', 'failed', { error: e.message });
          }
        }

        let fbId: string | undefined;
        if (nets.facebook) {
          const hidden = false;
          const net: Net = hidden ? 'instagram' : 'facebook';
          const t = row.texts.facebook;
          try {
            say(`${tag} → Facebook: começando${hidden ? ' (oculto, só para o Instagram puxar o vídeo)' : ''}.`);
            setNet(row.key, net, { phase: 'sending', step: 'Iniciando…' });
            if (!hidden) await record('facebook', 'sending', { title: t.title });
            const r = await uploadFacebook(s, row.video, row.cover, { title: t.title, description: t.description, publishAt: when, hidden },
              (sent) => setNet(row.key, net, { sent }), (step) => setNet(row.key, net, { step }));
            fbId = r.id;
            if (!hidden) {
              const scheduled = when.getTime() > Date.now() + 11 * 60_000;
              setNet(row.key, 'facebook', { phase: scheduled ? 'scheduled' : 'published', sent: row.video.size, step: undefined, url: r.url });
              say(`${tag} → Facebook: ${scheduled ? `agendado para ${fmtDate(when)}` : 'publicado'}.`, 'ok');
              await record('facebook', scheduled ? 'scheduled' : 'published', { remoteId: r.id, url: r.url });
            }
          } catch (e: any) {
            setNet(row.key, net, { phase: 'failed', error: e.message, step: undefined });
            say(`${tag} → Facebook falhou: ${e.message}`, 'error');
            if (!hidden) await record('facebook', 'failed', { error: e.message });
          }
        }

        void fbId;
        if (nets.instagram) {
          try {
            say(`${tag} → Instagram: enviando o vídeo (${(row.video.size / 1048576).toFixed(1)} MB).`);
            setNet(row.key, 'instagram', { phase: 'sending', step: 'Iniciando…' });
            await record('instagram', 'sending', { title: row.texts.instagram.description.split('\n')[0] });
            const r = await uploadInstagram(row.video, row.texts.instagram.description,
              (sent) => setNet(row.key, 'instagram', { sent }), (step) => setNet(row.key, 'instagram', { step }));
            setNet(row.key, 'instagram', { phase: 'published', step: undefined, url: r.url });
            say(`${tag} → Instagram: publicado agora.`, 'ok');
            await record('instagram', 'published', { remoteId: r.id, url: r.url, publishAt: new Date().toISOString() });
          } catch (e: any) {
            setNet(row.key, 'instagram', { phase: 'failed', error: e.message, step: undefined });
            say(`${tag} → Instagram falhou: ${e.message}`, 'error');
            await record('instagram', 'failed', { error: e.message });
          }
        }
      }
      // Vídeo que deu certo em todas as redes sai do rascunho; os que falharam ficam para tentar de novo.
      const okPhases = ['scheduled', 'published'];
      setRows((x) => x.filter((r) => {
        const ok = NETS.filter((n) => nets[n.id]).every((n) => okPhases.includes(r.state[n.id]?.phase ?? ''));
        return !ok;
      }));
      say('Terminado. Os vídeos enviados com sucesso saíram do rascunho (veja na aba Histórico); os que falharam continuam aqui.', 'ok');
    } catch (e: any) {
      setError(e.message);
      say(`Parado: ${e.message}`, 'error');
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  };

  const finished = !busy && startedAt !== null && counts.total > 0;

  return (
    <div className="new-batch">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ENVIO DIRETO</span>
          <h1>Postar<span className="accent-dot">.</span></h1>
          <p>O vídeo vai direto do seu computador para as redes. Nada fica guardado no servidor.</p>
        </div>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice.length > 0 && (
        <div className="alert" role="status">
          <Icon name="info" />
          <span>{notice.map((m, i) => <div key={i}>{m}</div>)}</span>
          <button className="link" onClick={() => setNotice([])}>ok</button>
        </div>
      )}

      <section className="panel">
        <h3>Redes</h3>
        <div className="platform-toggles">
          {NETS.map((n) => (
            <label key={n.id} className={`platform-card ${n.id} ${nets[n.id] ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={nets[n.id]} disabled={busy} onChange={(e) => setNets({ ...nets, [n.id]: e.target.checked })} />
              <span className="platform-avatar"><Icon name={n.id} size={22} /></span>
              <span className="platform-name">{n.label}<small>{n.kind}</small></span>
              <span className="selection-check"><Icon name="check" size={13} /></span>
            </label>
          ))}
          <label className="platform-card tiktok" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            <input type="checkbox" disabled checked={false} readOnly />
            <span className="platform-avatar"><Icon name="tiktok" size={22} /></span>
            <span className="platform-name">TikTok<small>em manutenção</small></span>
          </label>
        </div>
        <h3 className="post-subhead">Quando</h3>
        <div className="post-schedule">
          <label className="post-field">
            <span><Icon name="calendar" size={15} />Primeiro vídeo vai ao ar</span>
            <input type="datetime-local" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} />
          </label>
          <div className="post-field">
            <span><Icon name="clock" size={15} />Intervalo entre vídeos</span>
            <div className="post-stepper">
              <button type="button" disabled={busy || everyDays <= 0} onClick={() => setEveryDays(everyDays - 1)} aria-label="Menos um dia">−</button>
              <strong>{everyDays === 0 ? 'mesmo dia' : everyDays === 1 ? '1 dia' : `${everyDays} dias`}</strong>
              <button type="button" disabled={busy || everyDays >= 30} onClick={() => setEveryDays(everyDays + 1)} aria-label="Mais um dia">+</button>
            </div>
          </div>
          <div className="post-timeline" aria-label="Datas dos vídeos">
            {(rows.length ? rows : [null, null, null]).slice(0, 4).map((r, i) => (
              <span key={i} className={r ? '' : 'ghost'}><b>{i + 1}</b>{fmtDate(dateFor(i))}</span>
            ))}
            {rows.length > 4 && <span className="more">+{rows.length - 4}</span>}
          </div>
        </div>
      </section>

      {!busy && (
        <section
          className={drag ? 'dropzone post-drop over' : 'dropzone post-drop'}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void filesFromDrop(e.dataTransfer).then(buildGroups).then(add).catch((err) => setError(err.message));
          }}
        >
          <span className="post-drop-icon"><Icon name="folder" size={28} /></span>
          <p>
            <strong>{rows.length ? 'Arraste mais vídeos ou pastas' : 'Arraste vídeos ou pastas aqui'}</strong>
            <span className="muted">Em cada pasta: o vídeo, a capa JPG e o .txt. Títulos, descrições e capa são preenchidos sozinhos.</span>
          </p>
          <div className="post-drop-chips"><span><Icon name="video" size={13} />MP4 / MOV</span><span><Icon name="spark" size={13} />capa JPG</span><span><Icon name="copy" size={13} />divulgacao.txt</span></div>
          <div className="post-drop-actions">
          <button className="primary" onClick={() => fileInput.current?.click()}><Icon name="plus" size={17} />Selecionar vídeos</button>
          <button onClick={() => folderInput.current?.click()}><Icon name="folder" size={17} />Selecionar pasta</button>
          </div>
          <input ref={fileInput} type="file" multiple hidden accept="video/mp4,video/quicktime,.mp4,.mov,.jpg,.jpeg,.txt"
            onChange={(e) => { if (e.target.files) void buildGroups(filesFromInput(e.target.files)).then(add); e.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={(e) => { if (e.target.files) void buildGroups(filesFromInput(e.target.files)).then(add); e.target.value = ''; }} />
        </section>
      )}

      {(busy || finished) && (
        <section className="panel post-progress" aria-live="polite">
          <h3>{busy ? 'Enviando… não feche esta aba' : 'Resultado do envio'}</h3>
          <div className="post-bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="post-progress-stats">
            <span><strong>{pct}%</strong> · {mb(sentBytes)} de {mb(totalBytes)}</span>
            {busy && <span>Velocidade: <strong>{speed ? `${mb(speed)}/s` : 'medindo…'}</strong></span>}
            {busy && <span>Falta: <strong>{fmtTime(eta)}</strong></span>}
            <span>Tempo: {fmtTime(elapsed)}</span>
            <span>✅ {counts.ok} de {counts.total} prontos{counts.failed ? ` · ❌ ${counts.failed} falharam` : ''}</span>
          </div>
          <details open={busy || counts.failed > 0} style={{ marginTop: 10 }}>
            <summary>Registro detalhado ({log.length})</summary>
            <ol style={{ maxHeight: 220, overflow: 'auto', fontSize: 13, paddingLeft: 18 }}>
              {log.map((l, i) => (
                <li key={i} style={{ color: l.level === 'error' ? 'var(--danger, #d33)' : l.level === 'ok' ? 'var(--success, #2a7)' : undefined }}>
                  <span className="muted">{l.at.toLocaleTimeString('pt-BR')}</span> {l.text}
                </li>
              ))}
            </ol>
          </details>
          {finished && <a className="button" href="#/agenda">Ver Histórico<Icon name="arrow" size={16} /></a>}
        </section>
      )}

      {rows.length > 0 && (
        <section className="items">
          {rows.map((r, i) => (
            <DirectCard key={r.key} row={r} index={i} total={rows.length} when={dateFor(i)} nets={nets} busy={busy}
              onMove={(d) => move(i, d)}
              onRemove={() => setRows(rows.filter((x) => x.key !== r.key))}
              onText={(net, p) => patchRow(r.key, (x) => ({ ...x, texts: { ...x.texts, [net]: { ...x.texts[net], ...p } } }))}
              onCover={(file) => patchRow(r.key, (x) => ({ ...x, cover: file, coverUrl: URL.createObjectURL(file) }))}
              onMeta={(duration, dims) => patchRow(r.key, (x) => ({ ...x, duration, dims }))}
            />
          ))}
        </section>
      )}

      {rows.length > 0 && !busy && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => void run()}>
            <Icon name="upload" size={17} />{finished ? 'Postar de novo' : `Postar ${rows.length} vídeo(s)`}
          </button>
          <button onClick={() => { setRows([]); setLog([]); setStartedAt(null); }}>Limpar</button>
          <span className="muted">{mb(totalBytes)} para enviar.</span>
        </div>
      )}
    </div>
  );
}

function Counter({ text, net, field }: { text: string; net: Net; field: 'title' | 'description' }) {
  const rule = (RULES as any)[net]?.[field];
  if (!rule) return null;
  const n = [...text].length;
  return <span className={n > rule.max ? 'counter over' : n > rule.max * 0.9 ? 'counter near' : 'counter'}>{n}/{rule.max}</span>;
}

function DirectCard(props: {
  row: Row; index: number; total: number; when: Date; nets: Record<Net, boolean>; busy: boolean;
  onMove: (d: -1 | 1) => void; onRemove: () => void;
  onText: (net: Net, p: Partial<{ title: string; description: string }>) => void;
  onCover: (f: File) => void; onMeta: (duration: number, dims: string) => void;
}) {
  const { row, index, total, when, nets, busy } = props;
  const enabled = NETS.filter((n) => nets[n.id]).map((n) => n.id);
  const [tab, setTab] = useState<Net>(enabled[0] ?? 'youtube');
  const cur = enabled.includes(tab) ? tab : enabled[0];
  const coverInput = useRef<HTMLInputElement>(null);
  return (
    <article className="video-card" aria-label={`Vídeo ${index + 1}: ${row.name}`}>
      <div className="card-head">
        <span className="order">#{index + 1}</span>
        <span className="when"><strong>{fmtDate(when)}</strong> <small>(seu horário)</small></span>
        <span className="spacer" />
        {!busy && <>
          <button className="small" onClick={() => props.onMove(-1)} disabled={index === 0}>↑ Subir</button>
          <button className="small" onClick={() => props.onMove(1)} disabled={index === total - 1}>↓ Descer</button>
          <button className="small danger" onClick={props.onRemove}>Excluir</button>
        </>}
      </div>
      {row.posted?.length ? (
        <div className="alert error" role="status" style={{ margin: '8px 0' }}>
          ⚠️ Este vídeo já foi {row.posted.map((p) => `${p.status === 'scheduled' ? 'programado' : p.status === 'published' ? 'postado' : 'enviado'} no ${NET_LABEL[p.platform]}${p.publishAt ? ` para ${fmtDate(new Date(p.publishAt))}` : ''}`).join(' · ')}.
        </div>
      ) : null}
      <div className="card-body">
        <div className="media-col">
          <video className="preview" src={row.videoUrl} controls muted preload="metadata" playsInline
            onLoadedMetadata={(e) => props.onMeta(e.currentTarget.duration, `${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)} />
          <dl className="meta">
            <dt>Pasta / arquivo</dt><dd title={row.video.name}>{row.name}</dd>
            <dt>Duração</dt><dd>{row.duration ? fmtTime(row.duration) : '…'}</dd>
            <dt>Tamanho</dt><dd>{row.dims ? `${row.dims} · ` : ''}{mb(row.video.size)}</dd>
          </dl>
          <section className="cover">
            <h4>Thumbnail / capa</h4>
            {row.coverUrl ? (
              <div className="cover-preview">
                <img src={row.coverUrl} alt="Capa" />
                <div>
                  <small>{row.cover?.name}</small>
                  {!busy && <div className="row"><button className="small" onClick={() => coverInput.current?.click()}>Trocar</button></div>}
                </div>
              </div>
            ) : (
              <button className="cover-upload-button" disabled={busy} onClick={() => coverInput.current?.click()}>
                <span>+ Adicionar thumbnail</span><small>Imagem JPG</small>
              </button>
            )}
            <input ref={coverInput} type="file" accept="image/jpeg" hidden onChange={(e) => e.target.files?.[0] && props.onCover(e.target.files[0])} />
          </section>
          {Object.keys(row.state).length > 0 && (
            <ul className="cover-results">
              {NETS.filter((n) => row.state[n.id]).map((n) => {
                const st = row.state[n.id]!;
                const p = Math.min(100, Math.round((st.sent / row.video.size) * 100));
                return (
                  <li key={n.id} style={{ display: 'block', marginBottom: 8 }}>
                    <span className={`dot ${n.id}`} /> <strong>{n.label}:</strong> {PHASE_LABEL[st.phase]}
                    {st.phase === 'scheduled' && <> para {fmtDate(when)}</>}
                    {st.phase === 'sending' && <> · {p}% ({mb(Math.min(st.sent, row.video.size))} de {mb(row.video.size)})</>}
                    {st.url && <> · <a href={st.url} target="_blank" rel="noreferrer">abrir</a></>}
                    {st.phase === 'sending' && <progress max={100} value={p} style={{ width: '100%' }} />}
                    {st.step && <div className="muted" style={{ fontSize: 12 }}>{st.step}</div>}
                    {st.note && <div className="muted" style={{ fontSize: 12 }}>{st.note}</div>}
                    {st.error && <div className="field-error">{st.error}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="texts-col">
          <div className="ptabs" role="tablist" style={{ '--segment': Math.max(0, enabled.indexOf(cur)), '--segments': Math.max(1, enabled.length) } as CSSProperties}>
            {enabled.map((n) => (
              <button key={n} role="tab" aria-selected={cur === n} className={cur === n ? `ptab ${n} active` : `ptab ${n}`} onClick={() => setTab(n)}>
                {NET_LABEL[n]}
              </button>
            ))}
          </div>
          {cur && (
            <div className="ptab-panel" role="tabpanel">
              <div className="editor-context"><strong>{row.name}</strong><span>{NET_LABEL[cur]}</span></div>
              {cur !== 'instagram' && (
                <div className="field">
                  <label>Título {cur === 'youtube' && <span className="req">*</span>}<Counter text={row.texts[cur].title} net={cur} field="title" /></label>
                  <input value={row.texts[cur].title} disabled={busy} onChange={(e) => props.onText(cur, { title: e.target.value })} />
                </div>
              )}
              <div className="field">
                <label>{cur === 'instagram' ? 'Legenda' : 'Descrição'}<Counter text={row.texts[cur].description} net={cur} field="description" /></label>
                <textarea rows={9} value={row.texts[cur].description} disabled={busy} onChange={(e) => props.onText(cur, { description: e.target.value })} />
              </div>
              {cur === 'facebook' && nets.instagram && <p className="field-hint">O Instagram usa o vídeo enviado ao Facebook.</p>}
              {cur === 'instagram' && <p className="field-hint">O Instagram publica na hora do envio (a API não permite agendar).</p>}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
