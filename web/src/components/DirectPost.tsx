import { useEffect, useRef, useState } from 'react';
import type { Platform, PostRecord } from '../../../server/src/shared/types';
import { buildGroups, filesFromDrop, filesFromInput, type ImportGroup } from '../lib/folder-import';
import { directApi, publishInstagram, uploadFacebook, uploadYouTube } from '../lib/direct-upload';
import { Icon } from './ui/Icon';

type Net = 'youtube' | 'facebook' | 'instagram';
const NETS: Array<{ id: Net; label: string }> = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram (publica na hora)' },
];

interface Row extends ImportGroup {
  key: string;
  ytTitle: string;
  ytDesc: string;
  fbTitle: string;
  fbDesc: string;
  igDesc: string;
  status: Partial<Record<Net, string>>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return localInput(d);
}

function toRow(g: ImportGroup, i: number): Row {
  const base = g.video.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  return {
    ...g, key: `${Date.now()}-${i}-${g.video.name}`,
    ytTitle: g.texts?.youtube?.title ?? base, ytDesc: g.texts?.youtube?.description ?? '',
    fbTitle: g.texts?.facebook?.title ?? g.texts?.youtube?.title ?? base, fbDesc: g.texts?.facebook?.description ?? '',
    igDesc: g.texts?.instagram?.description ?? '',
    status: {},
  };
}

export function DirectPost() {
  const [rows, setRows] = useState<Row[]>([]);
  const [nets, setNets] = useState<Record<Net, boolean>>({ youtube: true, facebook: true, instagram: true });
  const [start, setStart] = useState(defaultStart);
  const [everyDays, setEveryDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const add = (groups: ImportGroup[]) => {
    if (!groups.length) return setError('Nenhum vídeo MP4/MOV encontrado.');
    setError(null);
    setRows((r) => [...r, ...groups.map(toRow)]);
  };
  const dateFor = (i: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i * everyDays);
    return d;
  };
  const patch = (key: string, p: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const setStatus = (key: string, net: Net, msg: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, status: { ...x.status, [net]: msg } } : x)));

  const run = async () => {
    setError(null);
    if (!rows.length) return setError('Adicione pelo menos um vídeo.');
    if (!nets.youtube && !nets.facebook && !nets.instagram) return setError('Escolha pelo menos uma rede.');
    setBusy(true);
    try {
      const s = await directApi.session();
      for (const n of NETS) if (nets[n.id] && s.errors[n.id]) throw new Error(`${n.label}: ${s.errors[n.id]}`);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const when = dateFor(i);
        const log = (platform: Platform, status: PostRecord['status'], extra: Partial<PostRecord> = {}) =>
          directApi.savePost({ id: `${row.key}-${platform}`, platform, status, video: row.name, publishAt: when.toISOString(), ...extra }).catch(() => undefined);

        if (nets.youtube) {
          try {
            await log('youtube', 'sending', { title: row.ytTitle });
            const r = await uploadYouTube(s, row.video, row.cover, { title: row.ytTitle, description: row.ytDesc, publishAt: when },
              (p) => setStatus(row.key, 'youtube', `Enviando ${p}%`));
            setStatus(row.key, 'youtube', `✅ Agendado ${when.toLocaleString('pt-BR')}${r.note ? ` · ${r.note}` : ''}`);
            await log('youtube', when.getTime() > Date.now() + 60_000 ? 'scheduled' : 'published', { remoteId: r.id, url: r.url });
          } catch (e: any) {
            setStatus(row.key, 'youtube', `❌ ${e.message}`);
            await log('youtube', 'failed', { error: e.message });
          }
        }

        let fbId: string | undefined;
        if (nets.facebook || nets.instagram) {
          const hidden = !nets.facebook; // só como ponte para o Instagram
          const net: Net = hidden ? 'instagram' : 'facebook';
          try {
            if (!hidden) await log('facebook', 'sending', { title: row.fbTitle });
            const r = await uploadFacebook(s, row.video, row.cover, { title: row.fbTitle, description: row.fbDesc, publishAt: when, hidden },
              (p) => setStatus(row.key, net, `${hidden ? 'Preparando' : 'Enviando'} ${p}%`));
            fbId = r.id;
            if (!hidden) {
              const scheduled = when.getTime() > Date.now() + 11 * 60_000;
              setStatus(row.key, 'facebook', scheduled ? `✅ Agendado ${when.toLocaleString('pt-BR')}` : '✅ Publicado');
              await log('facebook', scheduled ? 'scheduled' : 'published', { remoteId: r.id, url: r.url });
            }
          } catch (e: any) {
            setStatus(row.key, net, `❌ ${e.message}`);
            if (!hidden) await log('facebook', 'failed', { error: e.message });
            if (nets.instagram && hidden) await log('instagram', 'failed', { error: e.message });
          }
        }

        if (nets.instagram && fbId) {
          try {
            await log('instagram', 'sending', { title: row.igDesc.split('\n')[0] });
            const r = await publishInstagram(fbId, row.igDesc, !nets.facebook, (m) => setStatus(row.key, 'instagram', m));
            setStatus(row.key, 'instagram', '✅ Publicado agora');
            await log('instagram', 'published', { remoteId: r.id, url: r.url, publishAt: new Date().toISOString() });
          } catch (e: any) {
            setStatus(row.key, 'instagram', `❌ ${e.message}`);
            await log('instagram', 'failed', { error: e.message });
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

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

      <section className="panel">
        <h3>Redes</h3>
        <div className="platform-toggles">
          {NETS.map((n) => (
            <label key={n.id} className={`platform-card ${n.id} ${nets[n.id] ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={nets[n.id]} disabled={busy} onChange={(e) => setNets({ ...nets, [n.id]: e.target.checked })} />
              <span className="platform-avatar"><Icon name={n.id} size={22} /></span>
              <span className="platform-name">{n.label}</span>
            </label>
          ))}
          <label className="platform-card tiktok" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            <input type="checkbox" disabled checked={false} readOnly />
            <span className="platform-avatar"><Icon name="tiktok" size={22} /></span>
            <span className="platform-name">TikTok<small>em manutenção</small></span>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <label>Primeiro vídeo em<br /><input type="datetime-local" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} /></label>
          <label>Um vídeo a cada<br /><input type="number" min={0} max={30} value={everyDays} disabled={busy} onChange={(e) => setEveryDays(Math.max(0, Number(e.target.value) || 0))} style={{ width: 70 }} /> dia(s)</label>
        </div>
      </section>

      <section
        className={drag ? 'dropzone over' : 'dropzone'}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (busy) return;
          void filesFromDrop(e.dataTransfer).then(buildGroups).then(add).catch((err) => setError(err.message));
        }}
      >
        <p>
          <strong>Arraste vídeos ou pastas aqui</strong><br />
          <span className="muted">Em cada pasta: o vídeo, a imagem JPG (capa) e o .txt (títulos e descrições).</span>
        </p>
        <button className="primary" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus" size={17} />Selecionar vídeos</button>
        <button disabled={busy} onClick={() => folderInput.current?.click()}><Icon name="plus" size={17} />Selecionar pasta</button>
        <input ref={fileInput} type="file" multiple hidden accept="video/mp4,video/quicktime,.mp4,.mov,.jpg,.jpeg,.txt"
          onChange={(e) => { if (e.target.files) void buildGroups(filesFromInput(e.target.files)).then(add); e.target.value = ''; }} />
        <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: '', directory: '' } as any)}
          onChange={(e) => { if (e.target.files) void buildGroups(filesFromInput(e.target.files)).then(add); e.target.value = ''; }} />
      </section>

      {rows.map((r, i) => (
        <section className="panel" key={r.key}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{i + 1}. {r.name}</h3>
            <span className="muted">
              {(r.video.size / 1048576).toFixed(0)} MB · {r.cover ? 'com capa' : 'sem capa'} · {dateFor(i).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              {!busy && <> · <button className="link" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>remover</button></>}
            </span>
          </div>
          {nets.youtube && <>
            <label>YouTube · título<input value={r.ytTitle} maxLength={100} disabled={busy} onChange={(e) => patch(r.key, { ytTitle: e.target.value })} /></label>
            <label>YouTube · descrição<textarea rows={3} value={r.ytDesc} disabled={busy} onChange={(e) => patch(r.key, { ytDesc: e.target.value })} /></label>
          </>}
          {nets.facebook && <>
            <label>Facebook · título<input value={r.fbTitle} disabled={busy} onChange={(e) => patch(r.key, { fbTitle: e.target.value })} /></label>
            <label>Facebook · descrição<textarea rows={3} value={r.fbDesc} disabled={busy} onChange={(e) => patch(r.key, { fbDesc: e.target.value })} /></label>
          </>}
          {nets.instagram && <label>Instagram · legenda<textarea rows={3} value={r.igDesc} maxLength={2200} disabled={busy} onChange={(e) => patch(r.key, { igDesc: e.target.value })} /></label>}
          {Object.keys(r.status).length > 0 && (
            <ul className="muted">
              {NETS.filter((n) => r.status[n.id]).map((n) => <li key={n.id}><strong>{n.label.split(' ')[0]}:</strong> {r.status[n.id]}</li>)}
            </ul>
          )}
        </section>
      ))}

      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="primary" disabled={busy} onClick={() => void run()}>
            <Icon name="upload" size={17} />{busy ? 'Enviando… não feche esta aba' : `Postar ${rows.length} vídeo(s)`}
          </button>
          {!busy && <button onClick={() => setRows([])}>Limpar</button>}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<PostRecord['status'], string> = {
  sending: 'Enviando / interrompido', scheduled: 'Agendado', published: 'Publicado', failed: 'Falhou',
};
const NET_LABEL: Record<Platform, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };

export function PostHistory() {
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => directApi.posts().then(setPosts).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const groups = new Map<string, PostRecord[]>();
  for (const p of posts ?? []) groups.set(p.video, [...(groups.get(p.video) ?? []), p]);
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">HISTÓRICO</span>
          <h1>O que eu postei<span className="accent-dot">.</span></h1>
          <p>Cada vídeo, em quais redes, quando vai ao ar e o link.</p>
        </div>
        <button onClick={() => void load()}>Atualizar</button>
      </div>
      {error && <div className="alert error">{error}</div>}
      {posts && !posts.length && <p className="muted">Nenhum envio ainda. Use "Postar".</p>}
      {[...groups.entries()].map(([video, list]) => (
        <section className="panel" key={video}>
          <h3>{video}</h3>
          <table style={{ width: '100%' }}>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><strong>{NET_LABEL[p.platform]}</strong></td>
                  <td>{STATUS_LABEL[p.status]}{p.error ? ` — ${p.error}` : ''}</td>
                  <td>{p.publishAt ? new Date(p.publishAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td>
                  <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">abrir</a> : ''}</td>
                  <td><button className="link" onClick={() => { if (confirm('Apagar este registro do histórico? (não apaga da rede)')) void directApi.deletePost(p.id).then(load); }}>apagar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
