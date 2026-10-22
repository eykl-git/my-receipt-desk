/**
 * Native <dialog> shell for the review drawer and every dialog (design §9.3,
 * §9.4): showModal() traps focus, Escape and the Close button call onClose,
 * and focus returns to the element that opened it.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { COPY } from '../copy';
import { IconClose } from '../icons';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'drawer' | 'dialog';
  wide?: boolean;
  testId?: string;
}

export function Modal({ title, onClose, children, footer, variant = 'dialog', wide = false, testId }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog ref={ref} className={`modal modal-${variant}${wide ? ' modal-wide' : ''}`} aria-labelledby={titleId} data-testid={testId}>
      <div className="modal-frame">
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="btn btn-tertiary btn-close" onClick={() => onCloseRef.current()}>
            <IconClose />
            <span>{COPY.close}</span>
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
