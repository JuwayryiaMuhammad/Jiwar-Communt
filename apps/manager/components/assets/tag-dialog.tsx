'use client';

import { Alert, Button, Dialog } from '@jiwar/ui';

/**
 * A tag's code, shown once (ADR 0064): print it as a QR now. The previous
 * tag stopped working when this one was issued.
 */
export function TagDialog({ code, onClose }: { code: string | null; onClose: () => void }) {
  return (
    <Dialog
      open={code !== null}
      onClose={onClose}
      title="New tag"
      description="Print this as a QR and fix it where technicians will scan it. It is shown once: the previous tag no longer works."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="form">
        <code className="t-mono" style={{ wordBreak: 'break-all', userSelect: 'all' }}>
          {code}
        </code>
        <Alert tone="warn">Copy or print it now; it cannot be shown again.</Alert>
      </div>
    </Dialog>
  );
}
