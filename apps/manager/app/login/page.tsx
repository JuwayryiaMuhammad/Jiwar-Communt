'use client';

import { ApiError } from '@jiwar/api';
import { ErrorAlert } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Alert, Button, Field, Input, useLabel } from '@jiwar/ui';
import { Building2, ChevronRight, DoorOpen, ShieldCheck, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { bffAuth } from '@/lib/api';
import { safeNext } from '@/lib/nav';
import ar from '@/messages/ar/shell-login';
import en from '@/messages/en/shell-login';

interface LoginAccount {
  accountId: string;
  tenantName: string;
  accountType: string;
}

type Step = 'identifier' | 'code' | 'account' | 'denied';

function LoginFlow() {
  const t = useT(en, ar);
  const label = useLabel();
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);

  // Managers, and staff: a staff role may hold a maintenance permission,
  // which only the sign-in itself can tell.
  const eligible = accounts.filter((a) => a.accountType === 'manager' || a.accountType === 'staff');

  async function run(key: string, fn: () => Promise<void>) {
    setPending(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
      // The sign-in ticket is spent either way: start again from the top.
      if (err instanceof ApiError && err.code === 'NO_DASHBOARD_ACCESS') setStep('denied');
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
      // One account that could have access: nothing to choose.
      const able = result.accounts.filter((a) => a.accountType === 'manager' || a.accountType === 'staff');
      const only = able.length === 1 ? able[0] : undefined;
      if (only) {
        await bffAuth('select', { accountId: only.accountId, tenantName: only.tenantName });
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
          {step === 'account' ? t('title.account') : step === 'denied' ? t('title.denied') : t('title.signIn')}
        </h1>
        <p className="t-secondary">
          {step === 'identifier' && t('intro.identifier')}
          {step === 'code' && t('intro.code')}
          {step === 'account' && t('intro.account')}
          {step === 'denied' && t('intro.denied')}
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
          <Field label={t('identifier')}>
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
            {t('sendCode')}
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
          <Field label={t('code')} hint={t('sentFor', { identifier })}>
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
            {t('verify')}
          </Button>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Button variant="text" onClick={() => setStep('identifier')}>
              {t('changeIdentifier')}
            </Button>
            <Button variant="text" onClick={() => void requestCode()} disabled={pending !== null}>
              {t('resend')}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'denied' ? (
        <div className="stack">
          <p className="t-secondary">{t('deniedHint')}</p>
          <Button
            onClick={() => {
              setStep('identifier');
              setAccounts([]);
              setCode('');
              setError(null);
            }}
          >
            {t('anotherAccount')}
          </Button>
        </div>
      ) : null}

      {step === 'account' ? (
        <div className="stack">
          {eligible.length === 0 ? (
            <Alert tone="warn">{t('noEligible')}</Alert>
          ) : null}
          <div className="stack stack--sm">
            {accounts.map((a) => {
              const isManager = a.accountType === 'manager';
              const canTry = eligible.includes(a);
              return (
                <button
                  key={a.accountId}
                  type="button"
                  className="choice"
                  disabled={!canTry || pending !== null}
                  onClick={() => void choose(a)}
                >
                  <span className="avatar" aria-hidden>
                    <Building2 size={16} />
                  </span>
                  <span className="list__text">
                    <span className="list__title" style={{ display: 'block' }}>
                      {a.tenantName}
                    </span>
                    <span className="list__meta">
                      {isManager ? t('role.manager') : canTry ? t('role.staff') : t('useApp', { type: label(a.accountType) })}
                    </span>
                  </span>
                  {pending === a.accountId ? <span className="btn__spinner" aria-hidden /> : canTry ? <ChevronRight size={18} aria-hidden className="icon-dir" /> : null}
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
            {t('startOver')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function LoginPage() {
  const t = useT(en, ar);
  return (
    <div className="auth">
      <div className="auth__panel">
        <Suspense>
          <LoginFlow />
        </Suspense>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          {t('product')}
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>{t('tagline')}</h2>
          <p>{t('lede')}</p>
        </div>
        <div className="auth__points">
          <span className="auth__point">
            <Users aria-hidden /> {t('point.residents')}
          </span>
          <span className="auth__point">
            <DoorOpen aria-hidden /> {t('point.gates')}
          </span>
          <span className="auth__point">
            <ShieldCheck aria-hidden /> {t('point.roles')}
          </span>
        </div>
      </aside>
    </div>
  );
}
