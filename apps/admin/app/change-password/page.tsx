'use client';

import { useT } from '@jiwar/i18n';
import { Alert, Button, LanguageSwitcher } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { PasswordForm } from '@/components/password-form';
import { bffAuth } from '@/lib/api';
import appAr from '@/messages/ar/app';
import authAr from '@/messages/ar/auth';
import appEn from '@/messages/en/app';
import authEn from '@/messages/en/auth';

/** Forced after the first sign-in with a bootstrap password. */
export default function ChangePasswordPage() {
  const t = useT(authEn, authAr);
  const app = useT(appEn, appAr);
  const router = useRouter();
  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__lang">
          <LanguageSwitcher variant="text" />
        </div>
        <div className="auth__form">
          <div className="stack stack--sm">
            <span className="sidebar__mark" aria-hidden>
              J
            </span>
            <h1 className="t-display-md" style={{ marginTop: 16 }}>
              {t('change.title')}
            </h1>
            <p className="t-secondary">{t('change.body')}</p>
          </div>
          <Alert tone="info">{t('change.alert')}</Alert>
          <PasswordForm
            submitLabel={t('change.submit')}
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
            {t('change.back')}
          </Button>
        </div>
      </div>
      <aside className="auth__band">
        <span className="badge badge--green badge--plain" style={{ alignSelf: 'flex-start' }}>
          {app('meta.title')}
        </span>
        <div className="stack" style={{ gap: 16 }}>
          <h2>{t('change.bandTitle')}</h2>
          <p>{t('change.bandBody')}</p>
        </div>
        <span />
      </aside>
    </div>
  );
}
