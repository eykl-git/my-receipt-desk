/** A labelled form control: <label for> keeps the accessible name to the label text only. */
import { useId, type ReactNode } from 'react';

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children(id)}
      {hint}
    </div>
  );
}
