'use client';

import { Alert, Button } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { PasswordForm } from '@/components/password-form';
import { bffAuth } from '@/lib/api';

/** Forced after the first sign-in with a bootstrap password. */
export default function ChangePasswordPage() {
  const router = useRouter();
  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__form">
          <div className="stack stack--sm">
            <span className="sidebar__mark" aria-hidden>
              J
            </span>
            <h1 className="t-display-md" style={{ marginTop: 16 }}>
              Set a new password
            </h1>
            <p className="t-secondary">This password was set at setup. Choose your own before you continue.</p>
          </div>
          <Alert tone="info">Changing it signs out every other platform session.</Alert>
          <PasswordForm
            submitLabel="Save and continue"
            onDone={() => {
              router.replace('/');
              router.refresh();
            }}
          />
          <Button
            variant="text"
            onClick={async () => {
              await bffAuth('logout').catch(() => undefined);
              router.replace('/login');
            }}
          >
            Back to sign-in
          </Button>
        </div>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          Jiwar Platform
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>One more step.</h2>
          <p>The setup password stops working once you save a new one.</p>
        </div>
        <span />
      </aside>
    </div>
  );
}
