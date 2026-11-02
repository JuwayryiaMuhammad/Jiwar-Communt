'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, ConfirmDialog, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

interface Delivery {
  notifiedAt: string | null;
  remindedAt: string | null;
  notified: number;
  reminded: number;
  notifiedRead: number;
  remindedRead: number;
  pushSent: number;
  pushFailed: number;
  pushPending: number;
  opened: { accounts: number; audienceAccounts: number };
}

/**
 * How an announcement reached its audience (ADR 0080): the notice's and the
 * reminder's inbox rows and reads, the pushes by outcome, who opened it; and
 * the one reminder to whoever has not opened it. Counts only.
 */
export function AnnouncementDelivery({ id, out }: { id: string; out: boolean }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const key = ['announcement', id, 'delivery'];
  const delivery = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET('/api/v1/community/announcements/{id}/delivery', { params: { path: { id } } })) as Promise<Delivery>,
  });
  const remind = useAction(
    () => unwrap(api.POST('/api/v1/community/announcements/{id}/remind', { params: { path: { id } } })) as Promise<{ recipients: number }>,
    {
      invalidate: [key],
      onDone: (r: { recipients: number }) => {
        toast.show(`${r.recipients} ${r.recipients === 1 ? 'person was' : 'people were'} reminded.`);
        setConfirm(false);
      },
    },
  );
  const d = delivery.data;
  return (
    <Card>
      <CardBody>
        <QueryState query={delivery}>
          {d ? (
            <div className="stack">
              <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
                <Stat label="Told when it came out" value={`${d.notified}`} hint={`${d.notifiedRead} read it in their inbox`} />
                <Stat label="Reminded" value={`${d.reminded}`} hint={d.remindedAt ? `on ${formatDateTime(d.remindedAt)}` : 'Not yet'} />
                <Stat label="Pushes" value={`${d.pushSent} sent`} hint={`${d.pushFailed} failed, ${d.pushPending} to go`} />
                <Stat label="Opened it" value={`${d.opened.accounts} of ${d.opened.audienceAccounts}`} />
              </div>
              {out && !d.remindedAt ? (
                <span>
                  <Button onClick={() => setConfirm(true)}>Remind who has not opened it</Button>
                </span>
              ) : null}
              <ErrorAlert error={remind.error} />
            </div>
          ) : null}
        </QueryState>
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Remind who has not opened it?"
        description="Once only. Everyone it is put to who has not opened it is notified now."
        confirmLabel="Remind"
        pending={remind.isPending}
        onConfirm={() => remind.mutate()}
      />
    </Card>
  );
}
