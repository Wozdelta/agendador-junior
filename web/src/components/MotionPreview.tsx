import { useEffect, useRef, useState } from 'react';
import { LiquidNav } from './LiquidNav';
import { Icon } from './ui/Icon';
export function MotionPreview() {
  const [loop, setLoop] = useState(true),
    [route, setRoute] = useState('novo');
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current!;
    const resize = () =>
      el.style.setProperty('--stage-scale', `${Math.min(1, el.clientWidth / 470)}`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="motion-page page-enter">
      <div className="page-heading">
        <span className="eyebrow">LABORATÓRIO DE INTERAÇÃO</span>
        <h1>
          Liquid Stretch<span className="accent-dot">.</span>
        </h1>
        <p>O mesmo motor da navegação. Duas bordas, duas molas, um movimento contínuo.</p>
      </div>
      <div className="motion-controls">
        <button className={loop ? 'active' : ''} onClick={() => setLoop(true)}>
          <Icon name="play" />
          Loop de 4 segundos
        </button>
        <button className={!loop ? 'active' : ''} onClick={() => setLoop(false)}>
          <Icon name="pause" />
          Interativo
        </button>
      </div>
      <div className="motion-viewport" ref={stage}>
        <div className="motion-stage">
          <span className="motion-caption">AGENDADOR JUNIOR · MOTION STUDY 01</span>
          <LiquidNav
            route={route}
            onChange={(r) => {
              setLoop(false);
              setRoute(r);
            }}
            loop={loop}
            preview
          />
        </div>
      </div>
      <div className="motion-legend">
        <span>0s → Configurações</span>
        <span>1s → Agenda</span>
        <span>2s → Conexões</span>
        <span>3s → Novo lote</span>
      </div>
      <p className="field-hint">
        A prévia inclui o fim da mola anterior e a antecipação do próximo toque na virada do ciclo.
        Com movimento reduzido, o modo automático fica estático. Os controles continuam disponíveis.
      </p>
      <a href="#/novo" className="button">
        Voltar ao aplicativo <Icon name="arrow" />
      </a>
    </div>
  );
}
