// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualAgenda } from './ManualAgenda';
import { Connections } from './Connections';
import { App } from '../App';
import { api } from '../lib/api';
import { MANUAL_AGENDA_KEY } from '../lib/manual-agenda';
import { PLATFORMS, type SettingsDTO } from '../../../server/src/shared/types';
import { LiquidNav } from './LiquidNav';
import { readFileSync } from 'node:fs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settings: SettingsDTO = {
  mode: 'real',
  timezone: 'America/Sao_Paulo',
  publishTime: '12:00',
  lateToleranceMinutes: 20,
  minLeadMinutes: 15,
  publicBaseUrlConfigured: false,
  tiktokMode: 'manual',
  graphVersion: 'v27.0',
  remoteAccess: true,
  directLinks: false,
  serverPersistence: false,
  mediaPersistence: false,
  oauthAvailable: false,
  backgroundWorker: false,
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.spyOn(api,'session').mockResolvedValue({user:{id:'test',email:'admin@example.com'}});
  vi.spyOn(api,'manual').mockResolvedValue({rows:[]});
  window.localStorage.clear();
  window.location.hash = '#/novo';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(element: React.ReactNode) {
  await act(async () => {
    root.render(element);
  });
}
async function input(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    const prototype =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(selector: string) {
  await act(async () => host.querySelector<HTMLElement>(selector)!.click());
}
async function chooseFiles(names: string[]) {
  const el = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(el, 'files', {
    configurable: true,
    value: names.map((name) => new File(['test'], name, { type: 'video/mp4' })),
  });
  await act(async () => el.dispatchEvent(new Event('change', { bubbles: true })));
}
async function submit() {
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

describe('Novo lote e agenda — eventos DOM', () => {
  it.each([1440, 1024, 768, 390, 320])(
    'aplica as regras responsivas em %i px (sem motor de layout visual)',
    async (width) => {
      const viewport = window as unknown as {
        happyDOM: { setWindowSize: (size: { width: number; height: number }) => void };
      };
      viewport.happyDOM.setWindowSize({ width, height: 900 });
      const styles = document.createElement('style');
      styles.textContent = ['../styles.css', '../design.css', '../layout-refinements.css']
        .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
        .join('\n');
      document.head.append(styles);
      try {
        vi.spyOn(api, 'settings').mockResolvedValue(settings);
        await render(<App />);
        const nav = host.querySelector<HTMLElement>('.liquid-nav')!;
        const workspace = host.querySelector<HTMLElement>('.batch-workspace')!;
        expect(getComputedStyle(nav).position).toBe(width <= 700 ? 'fixed' : 'relative');
        const grid = getComputedStyle(workspace).gridTemplateColumns;
        expect(grid.includes('320px') || grid.includes('310px')).toBe(width > 850);
        expect(host.querySelectorAll('.liquid-tab')).toHaveLength(4);
        if (width <= 700)
          expect(getComputedStyle(host.querySelector('textarea')!).fontSize).toBe('16px');
      } finally {
        styles.remove();
      }
    },
  );
  it('seleciona cinco vídeos, recalcula datas sem remontar linhas, reordena e salva plataformas reais', async () => {
    await render(<ManualAgenda view="create" />);
    await input('input[placeholder="DD/MM/AAAA"]', '20/12/2026');
    await chooseFiles([
      '01-primeiro.mp4',
      '02-segundo.mp4',
      '03-terceiro.mp4',
      '04-quarto.mp4',
      '05-nome-muito-longo-para-validar-a-identidade-do-conteudo.mp4',
    ]);
    const firstLine = host.querySelector('.schedule-lines li');
    expect(host.querySelectorAll('.schedule-lines li')).toHaveLength(5);
    expect(host.querySelector('.schedule-lines')?.textContent).toContain('24/12/2026');
    await input('input[placeholder="DD/MM/AAAA"]', '21/12/2026');
    expect(host.querySelector('.schedule-lines li')).toBe(firstLine);
    expect(host.querySelector('.schedule-lines')?.textContent).toContain('25/12/2026');
    await click('.selected-files li:nth-child(2) button[aria-label*="para cima"]');
    await input('input[id$="-title"]', 'Série de dezembro');
    await input('textarea[id$="-description"]', 'Legenda compartilhada #teste');
    await click('.platform-card.facebook input');
    await submit();
    const stored = JSON.parse(localStorage.getItem(MANUAL_AGENDA_KEY)!);
    expect(stored).toHaveLength(5);
    expect(stored[0]).toMatchObject({
      date: '2026-12-21',
      originalName: '02-segundo.mp4',
      title: 'Série de dezembro',
      description: 'Legenda compartilhada #teste',
      platforms: { youtube: false, instagram: false, tiktok: false },
    });
    expect(stored[0].platforms.facebook).toBeUndefined();
    expect(stored[4].date).toBe('2026-12-25');
    expect(host.querySelector('[role=status]')?.textContent).toContain('5 registro(s) salvo(s)');
    expect(host.querySelectorAll('.selected-files li')).toHaveLength(0);
  });
  it('salva um vídeo e mantém os valores quando a gravação falha', async () => {
    await render(<ManualAgenda view="create" />);
    await chooseFiles(['unico.mp4']);
    await input('input[id$="-title"]', 'Título preservado');
    const original = window.localStorage;
    const failure = vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      length: original.length,
      clear: () => original.clear(),
      key: (i) => original.key(i),
      removeItem: (key) => original.removeItem(key),
      getItem: (key) => original.getItem(key),
      setItem: () => {
        throw new Error('Quota');
      },
    });
    await submit();
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Não foi possível salvar');
    expect(host.querySelector<HTMLInputElement>('input[id$="-title"]')?.value).toBe(
      'Título preservado',
    );
    expect(host.querySelectorAll('.selected-files li')).toHaveLength(1);
    failure.mockRestore();
    await submit();
    expect(JSON.parse(localStorage.getItem(MANUAL_AGENDA_KEY)!)).toHaveLength(1);
  });
  it('responde ao arraste, registra o vídeo e recusa arquivos inválidos sem perder a seleção', async () => {
    await render(<ManualAgenda view="create" />);
    const drop = host.querySelector<HTMLElement>('.file-drop')!;
    await act(async () =>
      drop.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true })),
    );
    expect(drop.classList.contains('is-over')).toBe(true);
    const send = async (file: File) => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      await act(async () => drop.dispatchEvent(event));
    };
    await send(new File(['test'], 'arrastado.mp4', { type: 'video/mp4' }));
    expect(drop.classList.contains('is-over')).toBe(false);
    expect(host.querySelectorAll('.selected-files li')).toHaveLength(1);
    await send(new File(['invalid'], 'texto.txt', { type: 'text/plain' }));
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'Selecione arquivos de vídeo',
    );
    expect(host.querySelectorAll('.selected-files li')).toHaveLength(1);
    await click('button[aria-label="Remover arrastado.mp4"]');
    expect(host.querySelectorAll('.selected-files li')).toHaveLength(0);
  });
  it('distingue agenda vazia de filtro vazio e marca uma rede sem alterar as demais', async () => {
    await render(<ManualAgenda view="agenda" />);
    expect(host.textContent).toContain('Espaço para suas próximas ideias');
    localStorage.setItem(
      MANUAL_AGENDA_KEY,
      JSON.stringify([
        {
          id: 'one',
          title: 'Vídeo de teste',
          description: 'Legenda',
          originalName: 'um.mp4',
          date: '2026-12-21',
          platforms: { youtube: false, tiktok: false },
        },
      ]),
    );
    await act(async () => window.dispatchEvent(new Event('storage')));
    await click('button[aria-label^="Registrar conclusão em YouTube"]');
    expect(JSON.parse(localStorage.getItem(MANUAL_AGENDA_KEY)!)[0].platforms).toEqual({
      youtube: true,
      tiktok: false,
    });
    await input('input[aria-label="Buscar vídeos na agenda"]', 'inexistente');
    expect(host.textContent).toContain('Nenhum resultado por aqui');
    expect(host.textContent).not.toContain('Espaço para suas próximas ideias');
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Limpar filtros')!
        .click(),
    );
    expect(host.querySelectorAll('.agenda-card')).toHaveLength(1);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:agenda-test');
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
    });
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Exportar agenda'))!
        .click(),
    );
    expect(downloadedName).toBe('agenda-manual.json');
    const exported = create.mock.calls[0][0] as Blob;
    expect(JSON.parse(await exported.text())[0].platforms).toEqual({
      youtube: true,
      tiktok: false,
    });
  });
  it('mantém os valores digitados ao navegar e sincroniza URLs diretas e retorno', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue(settings);
    vi.spyOn(api, 'connections').mockResolvedValue(
      PLATFORMS.map((platform) => ({
        platform,
        configured: false,
        connected: false,
        canConnect: false,
        capabilities: [],
        notes: [],
      })),
    );
    await render(<App />);
    await input('input[id$="-title"]', 'Não perder esta ideia');
    await click('.liquid-tab:nth-of-type(4)');
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    expect(window.location.hash).toBe('#/config');
    expect(host.querySelector('.liquid-tab[aria-current=page]')?.textContent).toBe('Configurações');
    expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      window.location.hash = '#/novo';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(host.querySelector<HTMLInputElement>('input[id$="-title"]')?.value).toBe(
      'Não perder esta ideia',
    );
    const button = host.querySelector<HTMLButtonElement>('.liquid-tab:nth-of-type(2)')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => {
      window.location.hash = '#/agenda';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(host.querySelector('.liquid-tab[aria-current=page]')?.textContent).toBe('Agenda');
  });
  it('recupera falha da integração e mantém alternativas manuais utilizáveis', async () => {
    const load = vi
      .spyOn(api, 'connections')
      .mockRejectedValueOnce(new Error('Integração indisponível'))
      .mockResolvedValue(
        PLATFORMS.map((platform) => ({
          platform,
          configured: false,
          connected: false,
          canConnect: false,
          capabilities: [],
          notes: ['Use a publicação manual.'],
        })),
      );
    await render(<Connections settings={settings} />);
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Integração indisponível');
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Tentar de novo')!
        .click(),
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('.conn')).toHaveLength(4);
    expect(host.querySelectorAll('.connection-actions a')).toHaveLength(4);
    expect(host.querySelector('[role=alert]')).toBeNull();
  });
  it('assenta imediatamente e não produz ripple com movimento reduzido', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(410);
    const raf = vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    await render(<LiquidNav route="novo" onChange={() => {}} />);
    await render(<LiquidNav route="config" onChange={() => {}} />);
    const nav = host.querySelector<HTMLElement>('.liquid-nav')!;
    expect(nav.style.getPropertyValue('--pill-left')).toBe('315.75px');
    expect(nav.style.getPropertyValue('--pill-width')).toBe('86px');
    await act(async () =>
      host.querySelector('button')!.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'touch',
          clientX: 20,
          clientY: 10,
        }),
      ),
    );
    expect(host.querySelector('.nav-ripple')).toBeNull();
    expect(raf).toHaveBeenCalledTimes(2);
  });
});
import {AuthGate} from './AuthGate';
describe('login e agenda no Supabase',()=>{
 it('só mostra o painel após login, salva cinco vídeos no servidor e encerra a sessão',async()=>{
  vi.mocked(api.session).mockResolvedValue({user:null});
  const login=vi.spyOn(api,'login').mockRejectedValueOnce(new Error('Este e-mail n\u00e3o tem acesso.')).mockRejectedValueOnce(new Error('E-mail ou senha inv\u00e1lidos.')).mockResolvedValue({user:{id:'admin',email:'admin@example.com'}});
  const logout=vi.spyOn(api,'logout').mockResolvedValue({ok:true});
  let saved:any[]=[];
  const save=vi.spyOn(api,'saveManual').mockImplementation(async ops=>{
   for(const op of ops as any[]) if(op.type==='insert'&&!saved.some(x=>x.id===op.value.id)) saved.push(op.value);
   return {rows:saved};
  });
  vi.mocked(api.manual).mockImplementation(async()=>({rows:saved}));
  await render(<AuthGate><ManualAgenda view="all"/></AuthGate>);
  expect(host.querySelector('.batch-form')).toBeNull();
  await input('input[type=email]','intruso@example.com');await input('input[type=password]','senha-de-teste');await submit();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('não tem acesso');
  await input('input[type=email]','admin@example.com');await submit();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('senha');
  expect(host.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('senha-de-teste');
  await input('input[type=password]','senha-correta');await submit();
  expect(login).toHaveBeenLastCalledWith('admin@example.com','senha-correta');
  expect(host.querySelector('input[autocomplete=one-time-code]')).toBeNull();
  await input('input[placeholder="DD/MM/AAAA"]','20/12/2026');
  await chooseFiles(['1.mp4','2.mp4','3.mp4','4.mp4','5.mp4']);await submit();
  expect(save).toHaveBeenCalled();expect(saved).toHaveLength(5);
  expect(saved[4].date).toBe('2026-12-24');expect(new Set(saved.map(x=>x.batchId)).size).toBe(1);
  expect(localStorage.getItem(MANUAL_AGENDA_KEY)).toBeNull();
  expect(host.textContent).toContain('no Supabase');
  const exit=[...host.querySelectorAll('button')].find(x=>x.textContent==='Sair')!;await act(async()=>exit.click());
  expect(logout).toHaveBeenCalledOnce();expect(host.querySelector('.batch-form')).toBeNull();expect(host.querySelector('input[type=email]')).not.toBeNull();
 });
 it('importa a cópia local explicitamente e preserva os valores quando o banco falha',async()=>{
  const legacy={id:'legacy-id',date:'2026-12-20',originalName:'antigo.mp4',title:'Antigo',description:'Legenda antiga',platforms:{youtube:true,tiktok:false}};
  localStorage.setItem(MANUAL_AGENDA_KEY,JSON.stringify([legacy]));
  let saved:any[]=[];
  vi.mocked(api.manual).mockImplementation(async()=>({rows:saved}));
  const save=vi.spyOn(api,'saveManual').mockImplementation(async ops=>{for(const op of ops as any[])if(op.type==='insert'&&!saved.some(x=>x.id===op.value.id))saved.push(op.value);return{rows:saved};});
  await render(<AuthGate><ManualAgenda view="all"/></AuthGate>);
  expect(save).not.toHaveBeenCalled();
  const button=[...host.querySelectorAll('button')].find(x=>x.textContent?.includes('Importar registros'))!;
  await act(async()=>button.click());await act(async()=>button.click());
  expect(saved).toHaveLength(1);expect(JSON.parse(localStorage.getItem(MANUAL_AGENDA_KEY)!)).toEqual([legacy]);
  save.mockImplementationOnce(async ops=>{for(const op of ops as any[])if(op.type==='insert')saved.push(op.value);throw new Error('Banco indisponível. Tente de novo.');});
  await input('input[placeholder="DD/MM/AAAA"]','21/12/2026');await input('input[id$="-title"]','Preservado');await chooseFiles(['novo.mp4']);await submit();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Banco indisponível');expect(host.querySelector<HTMLInputElement>('input[id$="-title"]')?.value).toBe('Preservado');expect(host.querySelectorAll('.selected-files li')).toHaveLength(1);
  await submit();expect(saved).toHaveLength(2);expect(host.querySelectorAll('.selected-files li')).toHaveLength(0);
 });
 it('Termos e Privacidade abrem sem consultar sessão',async()=>{
  window.history.replaceState({},'','/termos');await render(<App/>);expect(host.textContent).toContain('Termos de Uso');expect(api.session).not.toHaveBeenCalled();
  window.history.replaceState({},'','/privacidade');await render(<App/>);expect(host.textContent).toContain('Política de Privacidade');expect(api.session).not.toHaveBeenCalled();window.history.replaceState({},'','/');
 });
});
