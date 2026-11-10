'use client';

import { useT } from '@jiwar/i18n';
import { Alert, Button, Dialog } from '@jiwar/ui';
import ar from '@/messages/ar/assets-asset';
import en from '@/messages/en/assets-asset';

/**
 * A tag's code, shown once (ADR 0064): print it as a QR now. The previous
 * tag stopped working when this one was issued.
 */
export function TagDialog({ code, onClose }: { code: string | null; onClose: () => void }) {
  const t = useT(en, ar);
  return (
    <Dialog
      open={code !== null}
      onClose={onClose}
      title={t('tagTitle')}
      description={t('tagDescription')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('tagDone')}
        </Button>
      }
    >
      <div className="form">
        <code className="t-mono" dir="ltr" style={{ wordBreak: 'break-all', userSelect: 'all' }}>
          {code}
        </code>
        <Alert tone="warn">{t('tagWarn')}</Alert>
      </div>
    </Dialog>
  );
}
