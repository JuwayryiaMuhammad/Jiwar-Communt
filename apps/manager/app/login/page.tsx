'use client';

import { ApiError, humanize } from '@jiwar/api';
import { ErrorAlert } from '@jiwar/api/react';
import { Alert, Button, Field, Input } from '@jiwar/ui';
import { Building2, ChevronRight, DoorOpen, ShieldCheck, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { bffAuth } from '@/lib/api';
import { safeNext } from '@/lib/nav';

interface LoginAccount {
  accountId: string;
  tenantName: string;
  accountType: string;
}

type Step = 'identifier' | 'code' | 'account';

function LoginFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);

  const managers = accounts.filter((a) => a.accountType === 'manager');

  async function run(key: string, fn: () => Promise<void>) {
    setPending(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
      // A spent or expired ticket means starting over from the code.
      if (err instanceof ApiError && err.code === 'LOGIN_TICKET_INVALID') {
        setStep('code');
        setCode('');
      }
    } finally {
      setPending(null);
    }
  }

  const requestCode = () =>
    run('request', async () => {
      await bffAuth('request-code', { identifier });
      setStep('code');
      setCode('');
    });

  const choose = (account: LoginAccount) =>
    run(account.accountId, async () => {
      await bffAuth('select', { accountId: account.accountId, tenantName: account.tenantName });
      router.replace(safeNext(params.get('next')));
      router.refresh();
    });

  const verify = () =>
    run('verify', async () => {
      const result = await bffAuth<{ accounts: LoginAccount[] }>('verify-code', { identifier, code });
      setAccounts(result.accounts);
      const onlyManagers = result.accounts.filter((a) => a.accountType === 'manager');
      if (onlyManagers.length === 1 && onlyManagers[0]) {
        await bffAuth('select', { accountId: onlyManagers[0].accountId, tenantName: onlyManagers[0].tenantName });
        router.replace(safeNext(params.get('next')));
        router.refresh();
        return;
      }
      setStep('account');
    });

  return (
    <div className="auth__form">
      <div className="stack stack--sm">
        <span className="sidebar__mark" aria-hidden>
          J
        </span>
        <h1 className="t-display-md" style={{ marginTop: 16 }}>
          {step === 'account' ? 'Choose a compound' : 'Manager sign-in'}
        </h1>
        <p className="t-secondary">
          {step === 'identifier' && 'Enter your email or phone. We email you a 6-digit code.'}
          {step === 'code' && 'Check your email for the code. It expires in a few minutes.'}
          {step === 'account' && 'You manage more than one compound. Pick one for this session.'}
        </p>
      </div>

      {step === 'identifier' ? (
        <form
          className="form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (identifier.trim()) void requestCode();
          }}
        >
          <Field label="Email or phone">
            {(p) => (
              <Input
                {...p}
                autoComplete="username"
                autoFocus
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
              />
            )}
          </Field>
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" loading={pending === 'request'} disabled={!identifier.trim()}>
            Send code
          </Button>
        </form>
      ) : null}

      {step === 'code' ? (
        <form
          className="form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{6}$/.test(code)) void verify();
          }}
        >
          <Field label="Code" hint={`Sent for ${identifier}`}>
            {(p) => (
              <Input
                {...p}
                className="input--otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            )}
          </Field>
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" loading={pending === 'verify'} disabled={code.length !== 6}>
            Verify
          </Button>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Button variant="text" onClick={() => setStep('identifier')}>
              Change email or phone
            </Button>
            <Button variant="text" onClick={() => void requestCode()} disabled={pending !== null}>
              Send a new code
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'account' ? (
        <div className="stack">
          {managers.length === 0 ? (
            <Alert tone="warn">
              None of your accounts is a compound manager. Residents and staff use the Jiwar app.
            </Alert>
          ) : null}
          <div className="stack stack--sm">
            {accounts.map((a) => {
              const isManager = a.accountType === 'manager';
              return (
                <button
                  key={a.accountId}
                  type="button"
                  className="choice"
                  disabled={!isManager || pending !== null}
                  onClick={() => void choose(a)}
                >
                  <span className="avatar" aria-hidden>
                    <Building2 size={16} />
                  </span>
                  <span className="list__text">
                    <span className="list__title" style={{ display: 'block' }}>
                      {a.tenantName}
                    </span>
                    <span className="list__meta">{isManager ? 'Manager' : `${humanize(a.accountType)} · use the app`}</span>
                  </span>
                  {pending === a.accountId ? <span className="btn__spinner" aria-hidden /> : isManager ? <ChevronRight size={18} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <ErrorAlert error={error} />
          <Button
            variant="text"
            onClick={() => {
              setStep('identifier');
              setAccounts([]);
            }}
          >
            Start over
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="auth__panel">
        <Suspense>
          <LoginFlow />
        </Suspense>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          Jiwar Manager
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>Your compound, in one place.</h2>
          <p>Residents, households, staff, workers and the gate — with every decision on the record.</p>
        </div>
        <div className="auth__points">
          <span className="auth__point">
            <Users aria-hidden /> Residents, households and requests
          </span>
          <span className="auth__point">
            <DoorOpen aria-hidden /> Gates and the entry log
          </span>
          <span className="auth__point">
            <ShieldCheck aria-hidden /> Roles, settings and the audit trail
          </span>
        </div>
      </aside>
    </div>
  );
}
