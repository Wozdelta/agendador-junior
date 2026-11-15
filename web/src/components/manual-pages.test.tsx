import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManualAgenda } from './ManualAgenda';
import { App } from '../App';
import { MANUAL_AGENDA_KEY } from '../lib/manual-agenda';

afterEach(() => vi.unstubAllGlobals());
it('renderiza a agenda manual e estados separados sem API ou variáveis de ambiente', () => {
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === MANUAL_AGENDA_KEY ? JSON.stringify([
    { id: 'v1', title: 'Vídeo de teste', originalName: 'teste.mp4', date: '2026-12-10', description: 'Legenda', platforms: { youtube: true, tiktok: false } },
  ]) : null } });
  const html = renderToStaticMarkup(<ManualAgenda />);
  expect(html).toContain('10/12/2026');
  expect(html).toContain('12:00');
  expect(html).toContain('Concluído manualmente');
  expect(html).toContain('Publicação manual pendente');
  expect(html).not.toContain('Tentar de novo');
  expect(html).toContain('apenas neste navegador');
});
it('Agenda abre com alternativa manual mesmo antes de a API responder', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null }, location: { pathname: '/', hash: '#/agenda' } });
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('Agenda manual');
  expect(html).toContain('Salvar na agenda manual');
});
it('falha no armazenamento do navegador mostra erro e botão Tentar de novo', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('Storage bloqueado'); } } });
  const html = renderToStaticMarkup(<ManualAgenda />);
  expect(html).toContain('Nenhum dado foi apagado');
  expect(html).toContain('Tentar de novo');
});
