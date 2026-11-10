'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Dialog } from './dialog';
import { Field, Select, Textarea } from './form';
import { useCommonT, useLabel, type CodeLabels } from './i18n';

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
  textLabel,
  textHint,
  labels,
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
  /** Where the text goes: not every reason reaches the person. */
  textHint?: string;
  /** The page's own words for its codes, where the shared ones do not fit. */
  labels?: { en: CodeLabels; ar: CodeLabels };
  children?: ReactNode;
}) {
  const t = useCommonT();
  const label = useLabel(labels);
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
          <Button onClick={close}>{t('cancel')}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="form">
        {children}
        <Field label={t('reason.label')} error={touched && !code ? t('reason.pick') : undefined}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('select')}</option>
              {codes.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={textLabel ?? t('reason.textLabel')}
          hint={textHint ?? t('reason.textHint')}
          error={touched && !text.trim() ? t('required') : undefined}
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
  codeLabel,
  labels,
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
  /** What the code answers, when it is not a reason (e.g. how someone asked). */
  codeLabel?: string;
  /** The page's own words for its codes, where the shared ones do not fit. */
  labels?: { en: CodeLabels; ar: CodeLabels };
  onConfirm: (reasonCode: string) => void;
  children?: ReactNode;
}) {
  const t = useCommonT();
  const label = useLabel(labels);
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
          <Button onClick={close}>{t('cancel')}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="form">
        {children}
        <Field label={codeLabel ?? t('reason.label')} error={touched && !code ? t('reason.pickOne') : undefined}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('select')}</option>
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
  const t = useCommonT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      onSubmit={onConfirm}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
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
