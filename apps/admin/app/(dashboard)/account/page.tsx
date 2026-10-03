'use client';

import { Alert, Card, CardBody, CardHeader, PageHeader, useToast } from '@jiwar/ui';
import { PasswordForm } from '@/components/password-form';

export default function AccountPage() {
  const toast = useToast();
  return (
    <>
      <PageHeader title="Account" description="Your platform administrator sign-in." />
      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader title="Change password" />
          <CardBody>
            <div className="stack">
              <Alert tone="info">Saving signs out every other platform session. This one stays signed in.</Alert>
              <PasswordForm submitLabel="Change password" onDone={() => toast.show('Password changed.')} />
            </div>
          </CardBody>
        </Card>
        <Card tone="beige">
          <div className="stack stack--sm">
            <h2 className="t-title-md">Lockout</h2>
            <p>Repeated wrong passwords lock the account for a while. Each attempt is a security event.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
