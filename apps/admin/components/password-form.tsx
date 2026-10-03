'use client';

import { ErrorAlert, fieldError } from '@jiwar/api/react';
import { Button, Field, Input } from '@jiwar/ui';
import { useState } from 'react';
import { bffAuth } from '@/lib/api';

const MIN_LENGTH = 12;

/**
 * Change the platform password. The backend revokes every platform session
 * and returns a fresh one; the BFF swaps the cookies.
 */
export function PasswordForm({ onDone, submitLabel }: { onDone: () => void; submitLabel: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!current || next.length < MIN_LENGTH || next !== confirm) return;
    setPending(true);
    setError(null);
    try {
      await bffAuth('change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field label="Current password" error={touched && !current ? 'Required.' : undefined}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="New password"
        hint={`At least ${MIN_LENGTH} characters.`}
        error={
          (touched || tooShort) && next.length < MIN_LENGTH
            ? `At least ${MIN_LENGTH} characters.`
            : fieldError(error, 'newPassword')
        }
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </Field>
      <Field label="Repeat new password" error={mismatch || (touched && confirm !== next) ? 'Does not match.' : undefined}>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
      </Field>
      <ErrorAlert error={error} />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
