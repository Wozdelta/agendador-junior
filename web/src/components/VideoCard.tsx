import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  BatchItemDTO,
  ConnectionDTO,
  Platform,
  PlatformTexts,
} from '../../../server/src/shared/types';
import { PLATFORM_LABEL } from '../../../server/src/shared/types';
import { countText, RULES, validatePlatform } from '../../../server/src/shared/limits';
import { downloadUrl } from '../lib/api';
import { formatBytes, formatSec } from '../lib/date';

export interface UploadState {
  pct: number;
  objectUrl?: string;
  error?: string;
  active: boolean;
}

interface Props {
  item: BatchItemDTO;
  index: number;
  total: number;
  batchPlatforms: Record<Platform, boolean>;
  connections: ConnectionDTO[];
  upload?: UploadState;
  tiktokPrivacyOptions: string[] | null;
  onTexts: (itemId: string, platform: Platform, patch: Partial<PlatformTexts>) => void;
  onFrame: (itemId: string, ms: number) => void;
  onMove: (itemId: string, dir: -1 | 1) => void;
  onRemove: (itemId: string) => void;
  onCover: (itemId: string, file: File) => void;
  onRemoveCover: (itemId: string) => void;
  onReupload: (itemId: string, file: File) => void;
  dragProps: React.HTMLAttributes<HTMLElement>;
  isDragOver: boolean;
}

const PLATFORM_ORDER: Platform[] = ['facebook', 'youtube', 'instagram', 'tiktok'];
const KIND: Record<Platform, string> = {
  facebook: 'Reel',
  youtube: 'Short',
  instagram: 'Reel',
  tiktok: 'Vídeo',
};
const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Público',
  MUTUAL_FOLLOW_FRIENDS: 'Amigos',
  FOLLOWER_OF_CREATOR: 'Seguidores',
  SELF_ONLY: 'Somente eu',
};

function Counter({
  text,
  platform,
  field,
}: {
  text: string;
  platform: Platform;
  field: 'title' | 'description';
}) {
  const rule = field === 'title' ? RULES[platform].title : RULES[platform].description;
  if (!rule) return null;
  const n = countText(text, rule.count);
  const over = n > rule.max;
  const unit = rule.count === 'utf8bytes' ? ' bytes' : '';
  return (
    <span
      className={over ? 'counter over' : n > rule.max * 0.9 ? 'counter near' : 'counter'}
      title={rule.source}
    >
      {n.toLocaleString('pt-BR')}/{rule.max.toLocaleString('pt-BR')}
      {unit}
    </span>
  );
}

/** Resultado da capa por plataforma, conforme o que cada conexão suporta. */
function coverResult(p: Platform, item: BatchItemDTO, conn?: ConnectionDTO): string {
  const caps = conn?.capabilities ?? [];
  const frame = `quadro em ${(item.coverFrameMs / 1000).toFixed(1)} s`;
  const hasImg = !!item.cover;
  switch (p) {
    case 'youtube':
      return hasImg
        ? 'Imagem aplicada após o processamento (thumbnails.set)'
        : 'Capa automática do YouTube';
    case 'facebook':
      return hasImg
        ? caps.includes('cover_image')
          ? 'Imagem enviada como capa do Reel'
          : 'Somente manual: a imagem fica disponível para você aplicar'
        : 'Capa automática da Meta';
    case 'instagram':
      if (hasImg && caps.includes('cover_image')) return 'Imagem enviada (cover_url)';
      return hasImg
        ? `Usa o ${frame} (thumb_offset); imagem fica para uso manual`
        : `Usa o ${frame} (thumb_offset)`;
    case 'tiktok':
      if (caps.includes('direct'))
        return `Usa o ${frame} (video_cover_timestamp_ms)${hasImg ? '; imagem para uso manual' : ''}`;
      return hasImg
        ? 'Manual: escolha a capa no app do TikTok (imagem disponível)'
        : 'Manual: escolha a capa no app do TikTok';
  }
}

export function VideoCard(props: Props) {
  const { item, index, total, batchPlatforms, connections, upload } = props;
  const enabledPlatforms = PLATFORM_ORDER.filter((p) => batchPlatforms[p]);
  const [tab, setTab] = useState<Platform>(enabledPlatforms[0] ?? 'facebook');
  // Estado local dos textos: o servidor recebe as alterações com debounce, e a
  // digitação nunca é sobrescrita por respostas atrasadas.
  const [texts, setTexts] = useState(item.platforms);
  useEffect(() => setTexts(item.platforms), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [frameMs, setFrameMs] = useState(item.coverFrameMs);
  const frameVideo = useRef<HTMLVideoElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const reuploadInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!enabledPlatforms.includes(tab) && enabledPlatforms[0]) setTab(enabledPlatforms[0]);
  }, [enabledPlatforms.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (p: Platform, patch: Partial<PlatformTexts>) => {
    setTexts((t) => ({ ...t, [p]: { ...t[p], ...patch } }));
    props.onTexts(item.id, p, patch);
  };

  const ready = item.uploadStatus === 'ready' && item.media;
  const src = ready ? item.media!.url : upload?.objectUrl;
  const durationMs = Math.round((item.media?.durationSec ?? 0) * 1000);
  const interrupted = !ready && !upload?.active;

  const issuesFor = (p: Platform) => validatePlatform(p, texts[p], item.media, item.id);
  const conn = (p: Platform) =>
    connections.find((c) => c.platform === (p === 'instagram' ? 'instagram' : p));

  return (
    <article
      className={props.isDragOver ? 'video-card drag-over' : 'video-card'}
      aria-label={`Vídeo ${index + 1}: ${item.originalName}`}
    >
      <div className="card-head" {...props.dragProps}>
        <span className="drag-handle" title="Arraste para reordenar" aria-hidden>
          ⠿
        </span>
        <span className="order">#{index + 1}</span>
        <span className="when">
          <strong>{item.scheduledLocal}</strong> <small>(America/Sao_Paulo)</small>
        </span>
        <span className="spacer" />
        <button
          className="small"
          onClick={() => props.onMove(item.id, -1)}
          disabled={index === 0}
          aria-label="Subir"
        >
          ↑ Subir
        </button>
        <button
          className="small"
          onClick={() => props.onMove(item.id, 1)}
          disabled={index === total - 1}
          aria-label="Descer"
        >
          ↓ Descer
        </button>
        <button className="small danger" onClick={() => props.onRemove(item.id)}>
          Excluir
        </button>
      </div>

      <div className="card-body">
        <div className="media-col">
          {src ? (
            <video className="preview" src={src} controls muted preload="metadata" playsInline />
          ) : (
            <div className="preview placeholder">Sem prévia</div>
          )}
          <dl className="meta">
            <dt>Arquivo</dt>
            <dd title={item.originalName}>{item.originalName}</dd>
            <dt>Duração</dt>
            <dd>{formatSec(item.media?.durationSec)}</dd>
            {item.media?.width ? (
              <>
                <dt>Resolução</dt>
                <dd>
                  {item.media.width}×{item.media.height} · {formatBytes(item.media.size)}
                </dd>
              </>
            ) : null}
          </dl>
          {item.uploadStatus !== 'ready' && (
            <div className="upload-status">
              {upload?.active ? (
                <>
                  <progress max={100} value={upload.pct} aria-label="Progresso do envio" />
                  <span>
                    {upload.pct < 100
                      ? `Enviando… ${upload.pct}%`
                      : 'Verificando vídeo no servidor…'}
                  </span>
                </>
              ) : (
                <div className="field-error">
                  {item.uploadError ??
                    upload?.error ??
                    (interrupted
                      ? 'Envio interrompido (a página foi fechada). Selecione o arquivo de novo.'
                      : '')}
                </div>
              )}
              {interrupted && (
                <>
                  <button className="small" onClick={() => reuploadInput.current?.click()}>
                    Selecionar arquivo novamente
                  </button>
                  <input
                    ref={reuploadInput}
                    type="file"
                    accept="video/mp4,video/quicktime,.mp4,.mov"
                    hidden
                    onChange={(e) =>
                      e.target.files?.[0] && props.onReupload(item.id, e.target.files[0])
                    }
                  />
                </>
              )}
            </div>
          )}
          {ready && <div className="upload-ok">✓ Vídeo enviado e verificado</div>}

          <section className="cover">
            <h4>Capa do vídeo</h4>
            {item.cover ? (
              <div className="cover-preview">
                <img src={item.cover.url} alt="Capa enviada" />
                <div>
                  <small>{item.cover.originalName}</small>
                  <div className="row">
                    <a className="button small" href={downloadUrl(item.cover.url ?? '')}>
                      Baixar imagem
                    </a>
                    <button className="small" onClick={() => coverInput.current?.click()}>
                      Trocar
                    </button>
                    <button className="small danger" onClick={() => props.onRemoveCover(item.id)}>
                      Remover
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button className="small" onClick={() => coverInput.current?.click()}>
                Enviar imagem (opcional)
              </button>
            )}
            <input
              ref={coverInput}
              type="file"
              accept="image/jpeg,image/png"
              hidden
              onChange={(e) => e.target.files?.[0] && props.onCover(item.id, e.target.files[0])}
            />
            {ready && durationMs > 0 && (
              <div className="frame-picker">
                <label>
                  Quadro (para conexões que só aceitam quadro):{' '}
                  <strong>{(frameMs / 1000).toFixed(1)} s</strong>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, durationMs - 100)}
                    step={100}
                    value={frameMs}
                    onChange={(e) => {
                      const ms = Number(e.target.value);
                      setFrameMs(ms);
                      if (frameVideo.current) frameVideo.current.currentTime = ms / 1000;
                    }}
                    onPointerUp={() => props.onFrame(item.id, frameMs)}
                    onKeyUp={() => props.onFrame(item.id, frameMs)}
                  />
                </label>
                <video
                  ref={frameVideo}
                  className="frame-preview"
                  src={src}
                  muted
                  preload="metadata"
                  onLoadedMetadata={(e) => (e.currentTarget.currentTime = frameMs / 1000)}
                />
              </div>
            )}
            <ul className="cover-results">
              {enabledPlatforms.map((p) => (
                <li key={p}>
                  <span className={`dot ${p}`} /> {PLATFORM_LABEL[p]}:{' '}
                  {texts[p].enabled ? coverResult(p, item, conn(p)) : 'desativado neste vídeo'}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="texts-col">
          <div
            className="ptabs"
            role="tablist"
            aria-label="Textos por plataforma"
            style={
              {
                '--segment': Math.max(0, enabledPlatforms.indexOf(tab)),
                '--segments': Math.max(1, enabledPlatforms.length),
              } as CSSProperties
            }
          >
            {enabledPlatforms.map((p) => {
              const errs = texts[p].enabled
                ? issuesFor(p).filter((i) => i.level === 'error').length
                : 0;
              return (
                <button
                  key={p}
                  role="tab"
                  aria-selected={tab === p}
                  tabIndex={tab === p ? 0 : -1}
                  className={tab === p ? `ptab ${p} active` : `ptab ${p}`}
                  onClick={() => setTab(p)}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                    if (!direction && !['Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const index =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? enabledPlatforms.length - 1
                          : (enabledPlatforms.indexOf(p) + direction + enabledPlatforms.length) %
                            enabledPlatforms.length;
                    setTab(enabledPlatforms[index]);
                    (
                      event.currentTarget.parentElement?.children[index] as HTMLButtonElement
                    )?.focus();
                  }}
                >
                  {PLATFORM_LABEL[p]}
                  {!texts[p].enabled && <span className="muted"> (off)</span>}
                  {errs > 0 && (
                    <span className="badge-err" title={`${errs} pendência(s)`}>
                      {errs}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {enabledPlatforms.length === 0 && (
            <p className="muted">Nenhuma rede escolhida para o lote.</p>
          )}
          {enabledPlatforms.includes(tab) && (
            <div className="ptab-panel" role="tabpanel">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={texts[tab].enabled}
                  onChange={(e) => update(tab, { enabled: e.target.checked })}
                />
                Publicar este vídeo no {PLATFORM_LABEL[tab]} ({KIND[tab]})
              </label>
              {texts[tab].enabled && (
                <>
                  {RULES[tab].title && (
                    <div className="field">
                      <label>
                        Título {tab === 'youtube' && <span className="req">*</span>}
                        <Counter text={texts[tab].title} platform={tab} field="title" />
                      </label>
                      <input
                        value={texts[tab].title}
                        onChange={(e) => update(tab, { title: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label>
                      {tab === 'instagram' ? 'Legenda' : 'Descrição'}
                      <Counter text={texts[tab].description} platform={tab} field="description" />
                    </label>
                    <textarea
                      rows={5}
                      value={texts[tab].description}
                      onChange={(e) => update(tab, { description: e.target.value })}
                    />
                  </div>
                  {tab === 'youtube' && (
                    <fieldset className="field">
                      <legend>
                        Público: este vídeo é “feito para crianças”? <span className="req">*</span>
                      </legend>
                      <label className="radio">
                        <input
                          type="radio"
                          name={`kids-${item.id}`}
                          checked={texts.youtube.madeForKids === false}
                          onChange={() => update('youtube', { madeForKids: false })}
                        />{' '}
                        Não, não é feito para crianças
                      </label>
                      <label className="radio">
                        <input
                          type="radio"
                          name={`kids-${item.id}`}
                          checked={texts.youtube.madeForKids === true}
                          onChange={() => update('youtube', { madeForKids: true })}
                        />{' '}
                        Sim, é feito para crianças
                      </label>
                    </fieldset>
                  )}
                  {tab === 'tiktok' && props.tiktokPrivacyOptions && (
                    <fieldset className="field">
                      <legend>Direct Post</legend>
                      <label>
                        Privacidade
                        <select
                          value={texts.tiktok.privacyLevel ?? ''}
                          onChange={(e) =>
                            update('tiktok', { privacyLevel: e.target.value || null })
                          }
                        >
                          <option value="">Escolha…</option>
                          {props.tiktokPrivacyOptions.map((o) => (
                            <option key={o} value={o}>
                              {PRIVACY_LABEL[o] ?? o}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={!!texts.tiktok.disableComment}
                          onChange={(e) => update('tiktok', { disableComment: e.target.checked })}
                        />{' '}
                        Desativar comentários
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={!!texts.tiktok.disableDuet}
                          onChange={(e) => update('tiktok', { disableDuet: e.target.checked })}
                        />{' '}
                        Desativar dueto
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={!!texts.tiktok.disableStitch}
                          onChange={(e) => update('tiktok', { disableStitch: e.target.checked })}
                        />{' '}
                        Desativar costura
                      </label>
                      <label className="switch consent">
                        <input
                          type="checkbox"
                          checked={!!texts.tiktok.directPostConsent}
                          onChange={(e) =>
                            update('tiktok', { directPostConsent: e.target.checked })
                          }
                        />{' '}
                        Ao publicar, você concorda com a Music Usage Confirmation do TikTok e
                        autoriza o envio deste vídeo no horário agendado.
                      </label>
                    </fieldset>
                  )}
                  {tab === 'tiktok' && (
                    <button
                      className="small"
                      onClick={async () => {
                        await navigator.clipboard.writeText(texts.tiktok.description);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? 'Copiado!' : 'Copiar descrição'}
                    </button>
                  )}
                  <ul className="issues">
                    {issuesFor(tab).map((i, k) => (
                      <li key={k} className={i.level}>
                        {i.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
