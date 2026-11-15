import { useState } from 'react';
import { PLATFORMS, PLATFORM_LABEL, type Platform } from '../../../server/src/shared/types';
import { isoToBr, todayIsoSaoPaulo } from '../lib/date';
import { manualDates, markManualPlatform, readManualAgenda, saveManualAgenda, type ManualEntry } from '../lib/manual-agenda';

export const PLATFORM_HOME: Record<Platform, string> = {
  youtube: 'https://studio.youtube.com/', facebook: 'https://www.facebook.com/', instagram: 'https://www.instagram.com/', tiktok: 'https://www.tiktok.com/',
};
export function ManualAgenda() {
  const [initial] = useState(() => {
    try { return { rows: readManualAgenda(window.localStorage), error: '' }; }
    catch { return { rows: [], error: 'Não foi possível ler a agenda deste navegador. Nenhum dado foi apagado. Verifique o armazenamento do navegador e tente de novo.' }; }
  });
  const [rows, setRows] = useState<ManualEntry[]>(initial.rows);
  const [error, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(!!initial.error);
  const [date, setDate] = useState(todayIsoSaoPaulo);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([...PLATFORMS]);
  const [info, setInfo] = useState('');
  const save = (next: ManualEntry[]) => {
    if (blocked) { setError(initial.error); return false; }
    try {
      if (JSON.stringify(readManualAgenda(window.localStorage)) !== JSON.stringify(rows)) { setError('A agenda mudou em outra aba. Clique em Tentar de novo antes de salvar.'); return false; }
      saveManualAgenda(window.localStorage, next); setRows(next); setError(''); return true;
    }
    catch { setError('Não foi possível salvar. Libere espaço ou habilite o armazenamento deste navegador; seus registros anteriores foram preservados.'); return false; }
  };
  const reload = () => {
    try { setRows(readManualAgenda(window.localStorage)); setError(''); setBlocked(false); }
    catch { setError('A agenda continua indisponível neste navegador. Seus dados não foram apagados.'); }
  };
  return <section className="panel" aria-label="Agenda manual">
    <h2>Agenda manual</h2>
    <p>Planeje um vídeo por dia às <strong>12:00 em America/Sao_Paulo</strong>. No horário, abra a plataforma, envie o vídeo e registre a conclusão de cada rede.</p>
    <div className="alert">Os registros ficam apenas neste navegador. Vídeos e capas não são enviados nem guardados aqui. Não há publicação automática, lembrete em segundo plano ou sincronização entre dispositivos. Guarde seus arquivos e exporte uma cópia da agenda.</div>
    {error && <div className="alert error" role="alert">{error} <button onClick={reload}>Tentar de novo</button></div>}
    {info && <p role="status">{info}</p>}
    <form onSubmit={e => {
      e.preventDefault(); setInfo('');
      if ((!title.trim() && !files.length) || !platforms.length) { setError('Informe um título ou escolha vídeos e selecione pelo menos uma plataforma.'); return; }
      try {
        const names = files.length ? files : [title.trim()];
        const dates = manualDates(date, names.length);
        const added: ManualEntry[] = names.map((name, i) => ({ id: crypto.randomUUID(), date: dates[i], originalName: name, title: title.trim() || name, description, platforms: Object.fromEntries(platforms.map(p => [p, false])) }));
        if (save([...rows, ...added])) { setTitle(''); setDescription(''); setFiles([]); setInfo(`${added.length} registro(s) salvo(s) neste navegador.`); }
      } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível criar os registros.'); }
    }}>
      <div className="field"><label>Data inicial <input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label></div>
      <div className="field"><label>Título <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /></label></div>
      <div className="field"><label>Descrição <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={10000} /></label></div>
      <div className="field"><label>Vídeos (opcional, somente os nomes serão registrados) <input type="file" accept="video/*" multiple onChange={e => { setFiles(Array.from(e.target.files ?? []).map(f => f.name)); e.target.value = ''; }} /></label>{files.length > 0 && <p>{files.length} vídeo(s): {files.join(', ')}</p>}</div>
      <div className="row">{PLATFORMS.map(p => <label key={p}><input type="checkbox" checked={platforms.includes(p)} onChange={e => setPlatforms(ps => e.target.checked ? [...ps, p] : ps.filter(x => x !== p))} /> {PLATFORM_LABEL[p]}</label>)}</div>
      <button className="primary" type="submit">Salvar na agenda manual</button>
    </form>
    {rows.length > 0 && <button className="small" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'agenda-manual.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Exportar agenda</button>}
    {rows.length === 0 && <p className="empty">Nenhum registro manual ainda.</p>}
    {[...rows].sort((a, b) => a.date.localeCompare(b.date)).map(r => <article key={r.id} className="panel">
      <h3>{isoToBr(r.date)} 12:00 · {r.title}</h3><p className="muted">Arquivo: {r.originalName}</p>
      <label>Descrição deste vídeo<textarea value={r.description} onChange={e => save(rows.map(x => x.id === r.id ? { ...x, description: e.target.value } : x))} /></label>
      <button className="small" onClick={async () => {
        try { await navigator.clipboard.writeText(r.description); setInfo('Descrição copiada.'); }
        catch { setError('Não foi possível copiar automaticamente. Selecione e copie o texto da descrição.'); }
      }}>Copiar descrição</button>
      {PLATFORMS.filter(p => r.platforms[p] !== undefined).map(p => <div className="row" key={p}>
        <span>{PLATFORM_LABEL[p]}: {r.platforms[p] ? 'Concluído manualmente' : 'Publicação manual pendente'}</span>
        <a className="button small" href={PLATFORM_HOME[p]} target="_blank" rel="noreferrer">Abrir plataforma</a>
        <button className="small" onClick={() => save(markManualPlatform(rows, r.id, p))}>{r.platforms[p] ? 'Marcar pendente' : 'Registrar conclusão'}</button>
      </div>)}
      <button className="small danger" onClick={() => { if (confirm('Excluir este registro da agenda manual?')) save(rows.filter(x => x.id !== r.id)); }}>Excluir registro</button>
    </article>)}
  </section>;
}
