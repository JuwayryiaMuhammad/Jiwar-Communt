'use client';

import { errorText, unwrap } from '@jiwar/api';
import { Button, Dialog, Field, Input } from '@jiwar/ui';
import { useEffect, useRef, useState } from 'react';
import { validCode } from '@/components/finance/logic';
import { api } from '@/lib/api';

/**
 * Step-up (ADR 0036, 0046): before a sensitive change, a fresh code to the
 * signed-in account's own email. Opening the dialog sends the code;
 * a right code opens this session for one change, which `onVerified` then
 * makes.
 */
export function StepUpDialog({
  title,
  description,
  onVerified,
  onClose,
}: {
  title: string;
  description: string;
  onVerified: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const asked = useRef(false);

  const send = async () => {
    setError(null);
    try {
      await unwrap(api.POST('/api/v1/me/step-up', {}));
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void send();
  }, []);

  const verify = async () => {
    if (!validCode(code)) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST('/api/v1/me/step-up/verify', { body: { code: code.trim() } }));
      onVerified();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      onSubmit={() => void verify()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void send()}>Send a new code</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!validCode(code)}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Code" hint={sent ? 'Six digits, sent to your email. Valid for a few minutes.' : 'Sending a code to your email…'} error={error ?? undefined}>
          {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
