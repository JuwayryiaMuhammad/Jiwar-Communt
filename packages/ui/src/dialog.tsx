'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { Button } from './button';

/**
 * Native <dialog>: focus trap, Escape and the top layer come from the
 * browser. With `onSubmit` the body is a form, so Enter submits.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const content = (
    <>
      <header className="dialog__header">
        <div className="stack stack--sm" style={{ gap: 4 }}>
          <h2 className="t-title-md">{title}</h2>
          {description ? <p className="t-secondary">{description}</p> : null}
        </div>
        <Button variant="text" iconOnly aria-label="Close" onClick={onClose} icon={<X aria-hidden />} />
      </header>
      <div className="dialog__body">{children}</div>
      {footer ? <footer className="dialog__footer">{footer}</footer> : null}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        onSubmit ? (
          <form
            className="dialog__inner"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {content}
          </form>
        ) : (
          <div className="dialog__inner">{content}</div>
        )
      ) : null}
    </dialog>
  );
}
