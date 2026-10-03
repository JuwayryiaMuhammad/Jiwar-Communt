'use client';

import { ErrorAlert } from '@jiwar/api/react';
import { Button, Field, Input } from '@jiwar/ui';
import { Building2, ScrollText, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { bffAuth } from '@/lib/api';
import { safeNext } from '@/lib/nav';

function LoginForm() {
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
          Platform sign-in
        </h1>
        <p className="t-secondary">For Jiwar platform administrators.</p>
      </div>
      <div className="form">
        <Field label="Email">
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
        <Field label="Password">
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
          Sign in
        </Button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="auth__panel">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          Jiwar Platform
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>Every compound, one console.</h2>
          <p>Open compounds, appoint their managers, and watch sign-in security across the platform.</p>
        </div>
        <div className="auth__points">
          <span className="auth__point">
            <Building2 aria-hidden /> Compounds and their managers
          </span>
          <span className="auth__point">
            <ShieldCheck aria-hidden /> Security events across tenants
          </span>
          <span className="auth__point">
            <ScrollText aria-hidden /> Immutable platform audit trail
          </span>
        </div>
      </aside>
    </div>
  );
}
