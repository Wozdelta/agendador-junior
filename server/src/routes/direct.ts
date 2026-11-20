// Envio direto: o navegador manda o vídeo para YouTube e Facebook; nada fica guardado no Supabase.
// O servidor só entrega os tokens ao administrador logado, publica o Instagram a partir
// do link do vídeo já enviado ao Facebook e guarda o histórico (vídeo, rede, data, link).
import crypto from 'node:crypto';
import express, { Router } from 'express';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { graph, selectedPage } from '../platforms/meta.js';
import { YouTubeAdapter } from '../platforms/youtube.js';
import { getConn } from '../platforms/tokens.js';
import { PLATFORMS, type Platform, type PostRecord } from '../shared/types.js';
import { ah } from './middleware.js';

const str = (v: unknown, max = 70_000) => (typeof v === 'string' ? v.slice(0, max) : undefined);

export function directRoutes(ctx: AppContext): Router {
  const r = Router();
  const mc = () => ctx.modes.real;

  /** Tokens para o navegador enviar o vídeo. Só o administrador autenticado chega aqui. */
  r.post('/direct/session', ah(async (_req, res) => {
    await mc().connections.refresh();
    const out: Record<string, unknown> = { graphVersion: ctx.config.meta.graphVersion };
    const errors: Partial<Record<Platform, string>> = {};
    if (getConn(mc(), 'youtube')?.tokensEnc) {
      try { out.youtube = { accessToken: await new YouTubeAdapter(ctx).token({ ctx, mc: mc() }) }; }
      catch (e: any) { errors.youtube = e.message; }
    } else errors.youtube = 'YouTube não conectado. Abra "Conexões".';
    try {
      const page = selectedPage(ctx, mc());
      out.facebook = { pageId: page.pageId, pageName: page.pageName, pageToken: page.token };
      if (page.instagram) out.instagram = { igId: page.instagram.id, username: page.instagram.username };
      else errors.instagram = 'A Página escolhida não tem Instagram profissional vinculado.';
    } catch (e: any) {
      errors.facebook = e.message;
      errors.instagram = e.message;
    }
    res.json({ ...out, errors });
  }));

  /** Instagram: usa o link do vídeo já enviado ao Facebook para criar o Reel. */
  r.post('/direct/instagram/start', ah(async (req, res) => {
    const fbVideoId = str(req.body?.facebookVideoId, 64);
    if (!fbVideoId || !/^\d+$/.test(fbVideoId)) throw new AppError(400, 'Vídeo do Facebook inválido.');
    await mc().connections.refresh();
    const page = selectedPage(ctx, mc());
    if (!page.instagram) throw new AppError(409, 'A Página escolhida não tem Instagram profissional vinculado.');
    const v = await graph(ctx, `/${fbVideoId}`, { token: page.token, params: { fields: 'source,status' }, what: 'Link do vídeo no Facebook' });
    const st = v.status?.video_status;
    if (st === 'error') throw new AppError(422, 'O Facebook não conseguiu processar o vídeo; o Instagram não pôde ser publicado.');
    // Só usa o link quando o Facebook terminou de processar; antes disso o arquivo pode estar incompleto (erro 2207076).
    // Vídeo agendado não fica "ready" até ir ao ar; basta o processamento ter terminado.
    const processed = st === 'ready' || v.status?.processing_phase?.status === 'complete';
    if (!v.source || !processed) return res.json({ state: 'waiting', fbStatus: `${st ?? '?'} / processamento: ${v.status?.processing_phase?.status ?? '?'}` });
    const c = await graph(ctx, `/${page.instagram.id}/media`, {
      method: 'POST', token: page.token, what: 'Criação do Reel',
      params: { media_type: 'REELS', video_url: v.source, caption: str(req.body?.caption, 2200) ?? '', share_to_feed: true },
    });
    res.json({ state: 'processing', containerId: c.id });
  }));

  /** Instagram por envio direto: cria o Reel vazio e recebe o vídeo em pedaços (nada fica guardado). */
  r.post('/direct/instagram/create', ah(async (req, res) => {
    await mc().connections.refresh();
    const page = selectedPage(ctx, mc());
    if (!page.instagram) throw new AppError(409, 'A Página escolhida não tem Instagram profissional vinculado.');
    const c = await graph(ctx, `/${page.instagram.id}/media`, {
      method: 'POST', token: page.token, what: 'Criação do Reel',
      params: { media_type: 'REELS', upload_type: 'resumable', caption: str(req.body?.caption, 2200) ?? '', share_to_feed: true },
    });
    res.json({ containerId: c.id });
  }));

  r.post('/direct/instagram/chunk/:id', express.raw({ type: 'application/octet-stream', limit: '5mb' }), ah(async (req, res) => {
    const id = String(req.params.id);
    const offset = Number(req.query.offset), size = Number(req.query.size);
    if (!/^\d+$/.test(id) || !Number.isFinite(offset) || !Number.isFinite(size) || !Buffer.isBuffer(req.body)) throw new AppError(400, 'Pedaço do vídeo inválido.');
    await mc().connections.refresh();
    const page = selectedPage(ctx, mc());
    const up = await ctx.fetch(`https://rupload.facebook.com/ig-api-upload/${ctx.config.meta.graphVersion}/${id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${page.token}`, offset: String(offset), file_size: String(size), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(req.body as Buffer),
    });
    const txt = await up.text();
    // 206 = pedaço recebido, faltam outros; 200 = arquivo completo.
    if (up.status !== 200 && up.status !== 206) throw new AppError(502, `O Instagram recusou o envio do vídeo (${up.status}): ${txt.slice(0, 300)}`);
    res.json({ ok: true, done: up.status === 200 });
  }));

  r.post('/direct/instagram/check', ah(async (req, res) => {
    const containerId = str(req.body?.containerId, 64);
    if (!containerId || !/^\d+$/.test(containerId)) throw new AppError(400, 'Container inválido.');
    await mc().connections.refresh();
    const page = selectedPage(ctx, mc());
    if (!page.instagram) throw new AppError(409, 'Instagram não vinculado.');
    const s = await graph(ctx, `/${containerId}`, { token: page.token, params: { fields: 'status_code,status' }, what: 'Status do Reel' });
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') return res.json({ state: 'failed', error: `O Instagram não processou o vídeo: ${s.status ?? s.status_code}` });
    if (s.status_code !== 'FINISHED') return res.json({ state: 'processing' });
    const pub = await graph(ctx, `/${page.instagram.id}/media_publish`, { method: 'POST', token: page.token, params: { creation_id: containerId }, mayCreate: true, what: 'Publicação do Reel' });
    let url: string | undefined;
    try { url = (await graph(ctx, `/${pub.id}`, { token: page.token, params: { fields: 'permalink' }, what: 'Link do Reel' })).permalink; } catch {}
    // Vídeo usado só como ponte (Facebook desmarcado): apaga da Página.
    const carrier = str(req.body?.deleteFacebookVideoId, 64);
    if (carrier && /^\d+$/.test(carrier)) {
      try { await graph(ctx, `/${carrier}`, { method: 'DELETE', token: page.token, what: 'Remoção do vídeo ponte' }); } catch {}
    }
    res.json({ state: 'published', id: pub.id, url });
  }));

  // ---------- histórico ----------
  r.get('/direct/posts', ah(async (_req, res) => {
    await mc().posts.refresh();
    res.json(mc().posts.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }));

  r.post('/direct/posts', ah(async (req, res) => {
    const b = req.body ?? {};
    const platform = b.platform as Platform;
    if (!PLATFORMS.includes(platform)) throw new AppError(400, 'Rede inválida.');
    if (!['sending', 'scheduled', 'published', 'failed'].includes(b.status)) throw new AppError(400, 'Situação inválida.');
    const now = ctx.clock.now().toISOString();
    const id = str(b.id, 64) || crypto.randomUUID();
    let saved: PostRecord | undefined;
    await mc().posts.refresh();
    await mc().posts.mutate((d) => {
      const prev = d.find((x) => x.id === id);
      const rec: PostRecord = {
        id, platform,
        video: str(b.video, 300) ?? prev?.video ?? 'vídeo',
        fileKey: str(b.fileKey, 400) ?? prev?.fileKey,
        thumb: (typeof b.thumb === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.thumb) && b.thumb.length < 40_000 ? b.thumb : undefined) ?? prev?.thumb,
        title: str(b.title, 300) ?? prev?.title,
        status: b.status,
        publishAt: str(b.publishAt, 40) ?? prev?.publishAt,
        remoteId: str(b.remoteId, 120) ?? prev?.remoteId,
        url: str(b.url, 500) ?? prev?.url,
        error: b.status === 'failed' ? str(b.error, 1000) : undefined,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      if (prev) Object.assign(prev, rec); else d.push(rec);
      saved = rec;
    });
    res.json(saved);
  }));

  r.delete('/direct/posts/:id', ah(async (req, res) => {
    await mc().posts.refresh();
    const rec = mc().posts.all().find((x) => x.id === req.params.id);
    if (rec?.remoteId && rec.status !== 'failed' && rec.platform !== 'instagram' && req.query.remote === '1') {
      // Apaga também na rede. Se a rede recusar, mantém o registro e mostra o motivo.
      if (rec.platform === 'youtube') {
        const token = await new YouTubeAdapter(ctx).token({ ctx, mc: mc() });
        const r2 = await ctx.fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(rec.remoteId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
        if (!r2.ok && r2.status !== 404) throw new AppError(502, `O YouTube recusou apagar o vídeo (${r2.status}): ${(await r2.text()).slice(0, 300)}`);
      } else if (rec.platform === 'facebook') {
        const page = selectedPage(ctx, mc());
        try {
          await graph(ctx, `/${rec.remoteId}`, { method: 'DELETE', token: page.token, what: rec.platform === 'facebook' ? 'Remoção do vídeo no Facebook' : 'Remoção do Reel no Instagram' });
        } catch (e: any) {
          if (!/does not exist|cannot be loaded/i.test(e.message)) throw new AppError(502, `${rec.platform === 'facebook' ? 'O Facebook' : 'O Instagram'} recusou apagar: ${e.message}`);
        }
      }
    }
    await mc().posts.mutate((d) => { const i = d.findIndex((x) => x.id === req.params.id); if (i >= 0) d.splice(i, 1); });
    res.json({ ok: true });
  }));
  return r;
}
