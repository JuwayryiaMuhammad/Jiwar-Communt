'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Dialog } from './dialog';
import { Field, Select, Textarea } from './form';

function label(code: string) {
  const t = code.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Every rejection, suspension or removal takes a code from the action's
 * closed list plus the text the person is told (backend reasons.ts).
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  codes,
  confirmLabel,
  danger,
  pending,
  error,
  onConfirm,
  textLabel = 'Message to the person',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  codes: readonly string[];
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  error?: ReactNode;
  onConfirm: (reason: { reasonCode: string; reason: string }) => void;
  textLabel?: string;
  children?: ReactNode;
}) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = code !== '' && text.trim() !== '';

  const close = () => {
    setCode('');
    setText('');
    setTouched(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      onSubmit={() => {
        setTouched(true);
        if (valid) onConfirm({ reasonCode: code, reason: text.trim() });
      }}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="form">
        {children}
        <Field label="Reason" error={touched && !code ? 'Pick a reason.' : undefined}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Select…</option>
              {codes.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={textLabel}
          hint="Kept on the record and in the notice, never in the audit trail."
          error={touched && !text.trim() ? 'Required.' : undefined}
        >
          {(p) => <Textarea {...p} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        {error}
      </div>
    </Dialog>
  );
}

/**
 * For the actions whose reason is a code alone and never reaches anyone as
 * text (a ticket reassigned, a visit cancelled). `children` holds the
 * action's own fields; `ready` is false while they are incomplete.
 */
export function ReasonCodeDialog({
  open,
  onClose,
  title,
  description,
  codes,
  confirmLabel,
  danger,
  pending,
  error,
  ready = true,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  codes: readonly string[];
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  error?: ReactNode;
  ready?: boolean;
  onConfirm: (reasonCode: string) => void;
  children?: ReactNode;
}) {
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);

  const close = () => {
    setCode('');
    setTouched(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      onSubmit={() => {
        setTouched(true);
        if (code !== '' && ready) onConfirm(code);
      }}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="form">
        {children}
        <Field label="Reason" error={touched && !code ? 'Pick a reason.' : undefined}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Select…</option>
              {codes.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error}
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      onSubmit={onConfirm}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error ?? null}
    </Dialog>
  );
}
