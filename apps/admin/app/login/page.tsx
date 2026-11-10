'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Field, Input, useCommonT } from '@jiwar/ui';
import { Building2, ScrollText, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { bffAuth } from '@/lib/api';
import { safeNext } from '@/lib/nav';
import appAr from '@/messages/ar/app';
import authAr from '@/messages/ar/auth';
import appEn from '@/messages/en/app';
import authEn from '@/messages/en/auth';

function LoginForm() {
  const t = useT(authEn, authAr);
  const c = useCommonT();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { scope } = await bffAuth<{ scope: 'full' | 'password_change' }>('login', { email, password });
      router.replace(scope === 'password_change' ? '/change-password' : safeNext(params.get('next')));
      router.refresh();
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  return (
    <form className="auth__form" onSubmit={submit} noValidate>
      <div className="stack stack--sm">
        <span className="sidebar__mark" aria-hidden>
          J
        </span>
        <h1 className="t-display-md" style={{ marginTop: 16 }}>
          {t('login.title')}
        </h1>
        <p className="t-secondary">{t('login.subtitle')}</p>
      </div>
      <div className="form">
        <Field label={c('email')}>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label={t('login.password')}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <ErrorAlert error={error} />
        <Button type="submit" variant="primary" loading={pending} disabled={!email || !password}>
          {t('login.submit')}
        </Button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  const t = useT(authEn, authAr);
  const app = useT(appEn, appAr);
  return (
    <div className="auth">
      <div className="auth__panel">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          {app('meta.title')}
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>{t('login.bandTitle')}</h2>
          <p>{t('login.bandBody')}</p>
        </div>
        <div className="auth__points">
          <span className="auth__point">
            <Building2 aria-hidden /> {t('login.point.compounds')}
          </span>
          <span className="auth__point">
            <ShieldCheck aria-hidden /> {t('login.point.events')}
          </span>
          <span className="auth__point">
            <ScrollText aria-hidden /> {t('login.point.audit')}
          </span>
        </div>
      </aside>
    </div>
  );
}
