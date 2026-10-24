'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type StaffPartner } from '@/lib/queries';
import { daysLeft } from './logic';

/**
 * A partner's desk link (ADR 0060): the page the partner opens, with no
 * account, to accept, decline, propose another time or mark done. Shown
 * once when made: the server keeps only its hash. It stops working after
 * the compound's desk-link days, when a new one is made (the one before
 * stops at once) or when revoked. A partner without one has its requests
 * relayed by the management.
 */
export function DeskLinkCard({ partner }: { partner: StaffPartner }) {
  const toast = useToast();
  const [issued, setIssued] = useState<{ link: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const issue = useAction(() => unwrap(api.POST('/api/v1/staff/partners/{id}/desk-link', { params: { path: { id: partner.id } } })), {
    invalidate: [keys.partnersAll],
    onDone: (l) => setIssued({ link: l.link, expiresAt: l.expiresAt }),
  });
  const revoke = useAction(() => unwrap(api.POST('/api/v1/staff/partners/{id}/desk-link/revoke', { params: { path: { id: partner.id } } })), {
    invalidate: [keys.partnersAll],
    onDone: () => {
      setRevoking(false);
      toast.show('The desk link stopped working. The management relays this partner’s requests.');
    },
  });
  const live = partner.deskLink;
  return (
    <Card>
      <CardHeader
        title="Desk link"
        actions={
          <>
            {live ? (
              <Button variant="danger" onClick={() => setRevoking(true)}>
                Revoke
              </Button>
            ) : null}
            <Button variant="primary" loading={issue.isPending} disabled={partner.status !== 'active'} onClick={() => issue.mutate()}>
              {live ? 'Make a new link' : 'Make a link'}
            </Button>
          </>
        }
      />
      <CardBody>
        {live ? (
          <p>
            Live since {formatDateTime(live.createdAt)}. It stops on {formatDateTime(live.expiresAt)} ({daysLeft(live.expiresAt)} days left).
          </p>
        ) : (
          <p className="t-secondary">No live link: the management relays this partner’s requests from Partner requests.</p>
        )}
        {partner.status !== 'active' ? <Alert tone="warn">A suspended partner’s desk is closed.</Alert> : null}
        <ErrorAlert error={issue.error} />
      </CardBody>
      {issued ? (
        <Dialog
          open
          onClose={() => setIssued(null)}
          title="The partner’s desk link"
          description="Shown once: copy it now and give it to the partner. The link before stopped working."
          footer={
            <>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(issued.link);
                  toast.show('Copied.');
                }}
              >
                Copy
              </Button>
              <Button variant="primary" onClick={() => setIssued(null)}>
                Done
              </Button>
            </>
          }
        >
          <p className="t-mono" style={{ wordBreak: 'break-all' }}>
            {issued.link}
          </p>
          <p className="t-secondary">It works until {formatDateTime(issued.expiresAt)}.</p>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title="Revoke the desk link?"
        description="It stops working at once. Make a new one to give the partner its desk again."
        confirmLabel="Revoke"
        danger
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </Card>
  );
}
