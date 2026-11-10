'use client';

import { useT } from '@jiwar/i18n';
import { Alert, Card, CardBody, CardHeader, PageHeader, useToast } from '@jiwar/ui';
import { PasswordForm } from '@/components/password-form';
import ar from '@/messages/ar/auth';
import en from '@/messages/en/auth';

export default function AccountPage() {
  const t = useT(en, ar);
  const toast = useToast();
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.description')} />
      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader title={t('account.changeTitle')} />
          <CardBody>
            <div className="stack">
              <Alert tone="info">{t('account.alert')}</Alert>
              <PasswordForm submitLabel={t('account.changeSubmit')} onDone={() => toast.show(t('account.changed'))} />
            </div>
          </CardBody>
        </Card>
        <Card tone="beige">
          <div className="stack stack--sm">
            <h2 className="t-title-md">{t('account.lockoutTitle')}</h2>
            <p>{t('account.lockoutBody')}</p>
          </div>
        </Card>
      </div>
    </>
  );
}
