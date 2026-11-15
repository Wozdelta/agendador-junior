import { useId, useRef } from 'react';
import { brToIso, isoToBr, maskBrDate, todayIsoSaoPaulo } from '../lib/date';
import { Icon } from './ui/Icon';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  minDate?: string | false;
}

/** Campo DD/MM/AAAA com máscara e calendário nativo opcional. */
export function DateField({ label, value, onChange, error, hint, autoFocus, minDate }: Props) {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="date-input">
        <input
          id={id}
          inputMode="numeric"
          placeholder="DD/MM/AAAA"
          autoComplete="off"
          value={value}
          autoFocus={autoFocus}
          aria-invalid={!!error}
          aria-describedby={`${id}-msg`}
          onChange={(e) => onChange(maskBrDate(e.target.value))}
        />
        <button
          type="button"
          className="calendar-btn"
          title="Abrir calendário"
          onClick={() => {
            try {
              picker.current?.showPicker();
            } catch {
              picker.current?.focus();
            }
          }}
        >
          <Icon name="calendar" size={19} />
          <span className="sr-only">Abrir calendário</span>
        </button>
        <input
          ref={picker}
          className="hidden-date"
          type="date"
          tabIndex={-1}
          aria-hidden
          min={minDate === false ? undefined : (minDate ?? todayIsoSaoPaulo())}
          value={brToIso(value)}
          onChange={(e) => onChange(isoToBr(e.target.value))}
        />
      </div>
      <div
        id={`${id}-msg`}
        className={error ? 'field-error' : 'field-hint'}
        role={error ? 'alert' : undefined}
      >
        {error ?? hint}
      </div>
    </div>
  );
}
