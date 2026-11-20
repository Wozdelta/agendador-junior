import { useEffect, useMemo, useState } from 'react';
import type { Platform, PostRecord } from '../../../server/src/shared/types';
import { directApi } from '../lib/direct-upload';
import { Icon } from './ui/Icon';
import '../history.css';

const NET_LABEL: Record<Platform, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const STATUS: Record<PostRecord['status'], { label: string; cls: string }> = {
  scheduled: { label: 'Agendado', cls: 'scheduled' },
  published: { label: 'No ar', cls: 'published' },
  failed: { label: 'Falhou', cls: 'failed' },
  sending: { label: 'Interrompido', cls: 'sending' },
};
type Filter = 'all' | 'upcoming' | 'published' | 'failed';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Tudo' },
  { id: 'upcoming', label: 'Próximos' },
  { id: 'published', label: 'No ar' },
  { id: 'failed', label: 'Com falha' },
];

interface VideoGroup {
  key: string;
  title: string;
  when?: Date;
  thumb?: string;
  posts: PostRecord[];
}

/** Agendado com data passada já foi ao ar. */
const effective = (p: PostRecord, now: number): PostRecord['status'] =>
  p.status === 'scheduled' && p.publishAt && Date.parse(p.publishAt) <= now ? 'published' : p.status;

function relative(d: Date, now: number) {
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000), h = Math.round(abs / 3600000), days = Math.round(abs / 86400000);
  const txt = min < 60 ? `${min} min` : h < 36 ? `${h} h` : `${days} dias`;
  return diff > 0 ? `em ${txt}` : `há ${txt}`;
}
const dayKey = (d?: Date) => (d ? d.toISOString().slice(0, 10) : 'sem-data');
function dayLabel(d: Date | undefined, now: number) {
  if (!d) return 'Sem data';
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - start.getTime()) / 86400000);
  const raw = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const base = raw.charAt(0).toUpperCase() + raw.slice(1);
  return diff === 0 ? `Hoje · ${base}` : diff === 1 ? `Amanhã · ${base}` : diff === -1 ? `Ontem · ${base}` : base;
}

export function PostHistory() {
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [now, setNow] = useState(Date.now());
  const load = () => { setError(null); return directApi.posts().then((p) => { setPosts(p); setNow(Date.now()); }).catch((e) => setError(e.message)); };
  useEffect(() => { void load(); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const groups = useMemo(() => {
    const map = new Map<string, VideoGroup>();
    for (const p of posts ?? []) {
      const key = p.fileKey || p.video;
      const g = map.get(key) ?? { key, title: p.title || p.video, posts: [] };
      g.posts.push(p);
      if (p.platform === 'youtube' && p.title) g.title = p.title;
      if (p.thumb) g.thumb = p.thumb;
      // Vídeo privado/agendado do YouTube tem miniatura cinza; só usa a do YouTube depois que vai ao ar.
      else if (!g.thumb && p.platform === 'youtube' && p.remoteId && effective(p, Date.now()) === 'published') g.thumb = `https://i.ytimg.com/vi/${p.remoteId}/hqdefault.jpg`;
      const w = p.publishAt ? new Date(p.publishAt) : undefined;
      if (w && (!g.when || w < g.when)) g.when = w;
      map.set(key, g);
    }
    const order: Platform[] = ['youtube', 'facebook', 'instagram', 'tiktok'];
    for (const g of map.values()) g.posts.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
    return [...map.values()];
  }, [posts]);

  const stats = useMemo(() => {
    const s = { scheduled: 0, published: 0, failed: 0, next: undefined as PostRecord | undefined };
    for (const p of posts ?? []) {
      const st = effective(p, now);
      if (st === 'scheduled') {
        s.scheduled++;
        if (!s.next || Date.parse(p.publishAt!) < Date.parse(s.next.publishAt!)) s.next = p;
      } else if (st === 'published') s.published++;
      else if (st === 'failed') s.failed++;
    }
    return s;
  }, [posts, now]);

  const visible = groups.filter((g) => {
    const sts = g.posts.map((p) => effective(p, now));
    if (filter === 'upcoming') return sts.includes('scheduled');
    if (filter === 'published') return sts.includes('published');
    if (filter === 'failed') return sts.includes('failed') || sts.includes('sending');
    return true;
  });
  // Próximos primeiro (em ordem), depois os que já foram ao ar (mais recentes primeiro).
  visible.sort((a, b) => {
    const ta = a.when?.getTime() ?? 0, tb = b.when?.getTime() ?? 0;
    const fa = ta > now, fb = tb > now;
    if (fa !== fb) return fa ? -1 : 1;
    return fa ? ta - tb : tb - ta;
  });
  const days: Array<{ key: string; label: string; items: VideoGroup[] }> = [];
  for (const g of visible) {
    const k = dayKey(g.when);
    const last = days[days.length - 1];
    if (last?.key === k) last.items.push(g);
    else days.push({ key: k, label: dayLabel(g.when, now), items: [g] });
  }

  const removeVideo = async (g: VideoGroup) => {
    if (!confirm(`Apagar "${g.title}" do histórico (${g.posts.map((p) => NET_LABEL[p.platform]).join(', ')})?\n\nIsso NÃO apaga o vídeo das redes.`)) return;
    for (const p of g.posts) await directApi.deletePost(p.id).catch((e) => setError(e.message));
    void load();
  };
  const remove = async (p: PostRecord) => {
    if (!confirm(`Apagar o registro de ${NET_LABEL[p.platform]} do histórico?\n\nIsso NÃO apaga o vídeo da rede.`)) return;
    await directApi.deletePost(p.id).catch((e) => setError(e.message));
    void load();
  };

  return (
    <div className="history-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">HISTÓRICO</span>
          <h1>O que eu postei<span className="accent-dot">.</span></h1>
          <p>Cada vídeo, em quais redes, quando vai ao ar e o link.</p>
        </div>
        <button onClick={() => void load()}><Icon name="clock" size={15} />Atualizar</button>
      </div>

      <div className="history-stats">
        <div className="history-stat next">
          <span>Próximo a ir ao ar</span>
          {stats.next ? (
            <>
              <strong>{relative(new Date(stats.next.publishAt!), now)}</strong>
              <small title={stats.next.title || stats.next.video}>{stats.next.title || stats.next.video}</small>
            </>
          ) : <strong className="muted">—</strong>}
        </div>
        <div className="history-stat"><span>Agendados</span><strong>{stats.scheduled}</strong><small>esperando a data</small></div>
        <div className="history-stat ok"><span>No ar</span><strong>{stats.published}</strong><small>já publicados</small></div>
        <div className={stats.failed ? 'history-stat bad' : 'history-stat'}><span>Falhas</span><strong>{stats.failed}</strong><small>{stats.failed ? 'precisam de atenção' : 'tudo certo'}</small></div>
      </div>

      <div className="history-filters" role="tablist" aria-label="Filtrar histórico">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>

      {error && <div className="alert error">{error}</div>}
      {!posts && !error && <div className="history-empty">Carregando…</div>}
      {posts && !visible.length && (
        <div className="history-empty">
          <Icon name="video" size={28} />
          <strong>{posts.length ? 'Nada neste filtro.' : 'Nenhum envio ainda.'}</strong>
          {!posts.length && <a className="button primary" href="#/novo">Postar vídeos<Icon name="arrow" size={16} /></a>}
        </div>
      )}

      {days.map((d) => (
        <section key={d.key} className="history-day">
          <h2>{d.label}</h2>
          {d.items.map((g) => (
            <article key={g.key} className="history-card">
              <div className="history-thumb">
                {g.thumb ? <img src={g.thumb} alt="" loading="lazy" /> : <Icon name="video" size={22} />}
              </div>
              <div className="history-main">
                <div className="history-title">
                  <strong title={g.title}>{g.title}</strong>
                  <span className="history-actions">
                    {g.when && (
                      <span className="history-when">
                        <Icon name="clock" size={13} />
                        {g.when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        <em>{relative(g.when, now)}</em>
                      </span>
                    )}
                    <button className="history-delete" onClick={() => void removeVideo(g)} title="Apagar este vídeo do histórico">
                      <Icon name="trash" size={14} />Apagar
                    </button>
                  </span>
                </div>
                <ul className="history-nets">
                  {g.posts.map((p) => {
                    const st = STATUS[effective(p, now)];
                    return (
                      <li key={p.id} className={`history-net ${p.platform}`}>
                        <span className="net-icon"><Icon name={p.platform} size={14} /></span>
                        <span className="net-name">{NET_LABEL[p.platform]}</span>
                        <span className={`history-pill ${st.cls}`}>{st.label}</span>
                        {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="net-link">Abrir ↗</a>}
                        <button className="net-remove" title={`Apagar só o ${NET_LABEL[p.platform]} do histórico`} aria-label={`Apagar registro de ${NET_LABEL[p.platform]}`} onClick={() => void remove(p)}><Icon name="trash" size={13} /></button>
                        {p.error && <span className="net-error">{p.error}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
