'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type StaffPartner } from '@/lib/queries';
import ar from '@/messages/ar/partners-list';
import en from '@/messages/en/partners-list';
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
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
      toast.show(t('desk.revoked'));
    },
  });
  const live = partner.deskLink;
  return (
    <Card>
      <CardHeader
        title={t('desk.title')}
        actions={
          <>
            {live ? (
              <Button variant="danger" onClick={() => setRevoking(true)}>
                {t('desk.revoke')}
              </Button>
            ) : null}
            <Button variant="primary" loading={issue.isPending} disabled={partner.status !== 'active'} onClick={() => issue.mutate()}>
              {live ? t('desk.makeNew') : t('desk.make')}
            </Button>
          </>
        }
      />
      <CardBody>
        {live ? (
          <p>
            {t('desk.live', { since: f.dateTime(live.createdAt), until: f.dateTime(live.expiresAt), days: daysLeft(live.expiresAt) })}
          </p>
        ) : (
          <p className="t-secondary">{t('desk.none')}</p>
        )}
        {partner.status !== 'active' ? <Alert tone="warn">{t('desk.suspended')}</Alert> : null}
        <ErrorAlert error={issue.error} />
      </CardBody>
      {issued ? (
        <Dialog
          open
          onClose={() => setIssued(null)}
          title={t('desk.issuedTitle')}
          description={t('desk.issuedDescription')}
          footer={
            <>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(issued.link);
                  toast.show(t('desk.copied'));
                }}
              >
                {t('desk.copy')}
              </Button>
              <Button variant="primary" onClick={() => setIssued(null)}>
                {c('done')}
              </Button>
            </>
          }
        >
          <p className="t-mono ltr" style={{ wordBreak: 'break-all' }}>
            {issued.link}
          </p>
          <p className="t-secondary">{t('desk.works', { date: f.dateTime(issued.expiresAt) })}</p>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title={t('desk.revokeTitle')}
        description={t('desk.revokeDescription')}
        confirmLabel={t('desk.revoke')}
        danger
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </Card>
  );
}
