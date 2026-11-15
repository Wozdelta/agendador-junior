import { useState } from 'react';
import { PLATFORM_LABEL, type Platform, type PlatformTexts } from '../../../server/src/shared/types';
import { countText, RULES, validatePlatform } from '../../../server/src/shared/limits';
import type { PublicationTexts } from '../../../server/src/shared/publication';

export function PublicationEditor({ name, platforms, texts, onChange, disabled = false }: {
  name: string; platforms: Platform[]; texts: PublicationTexts;
  onChange: (platform: Platform, patch: Partial<PlatformTexts>) => void;
  disabled?: boolean;
}) {
  const [selected, select] = useState<Platform>(platforms[0] ?? 'facebook');
  const [notice, setNotice] = useState('');
  const platform = platforms.includes(selected) ? selected : platforms[0];
  if (!platform) return <p>Selecione pelo menos uma plataforma.</p>;
  const value = texts[platform];
  const rules = RULES[platform];
  const issues = validatePlatform(platform, { ...value, madeForKids: false }, undefined);
  return <section className="publication-editor" aria-label={`Textos de ${name}`}>
    <div className="editor-context"><strong>{name}</strong><span>{PLATFORM_LABEL[platform]}</span></div>
    <div className="publication-tabs" role="tablist" aria-label={`Plataformas de ${name}`}>
      {platforms.map(p => <button type="button" key={p} role="tab" aria-selected={platform === p} onClick={() => { select(p); setNotice(''); }}>{PLATFORM_LABEL[p]}</button>)}
    </div>
    <fieldset disabled={disabled} role="tabpanel" aria-label={`${name} · ${PLATFORM_LABEL[platform]}`}>
      {rules.title && <label className="field">Título <span className="counter">{countText(value.title, rules.title.count)}/{rules.title.max}</span>
        <input aria-label={`Título · ${name} · ${PLATFORM_LABEL[platform]}`} value={value.title} onChange={e => onChange(platform, { title: e.target.value })} />
      </label>}
      <label className="field">Descrição <span className="counter">{countText(value.description, rules.description.count)}/{rules.description.max}{rules.description.count === 'utf8bytes' ? ' bytes' : ''}</span>
        <textarea rows={5} aria-label={`Descrição · ${name} · ${PLATFORM_LABEL[platform]}`} value={value.description} onChange={e => onChange(platform, { description: e.target.value })} />
      </label>
      <ul className="issues">{issues.map((i, n) => <li key={n} className={i.level}>{i.message}</li>)}</ul>
      <details><summary>Prévia · {PLATFORM_LABEL[platform]}</summary><strong>{rules.title ? value.title : name}</strong><p className="publication-copy">{value.description || 'Sem descrição'}</p></details>
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(value.description); setNotice('Legenda copiada.'); } catch { setNotice('Não foi possível copiar. Selecione o texto para copiar.'); } }}>Copiar legenda</button>
      <span role="status">{notice}</span>
    </fieldset>
  </section>;
}
