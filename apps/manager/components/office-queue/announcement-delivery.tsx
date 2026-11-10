'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, ConfirmDialog, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/services-office-queue';
import en from '@/messages/en/services-office-queue';

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
  const t = useT(en, ar);
  const fmt = useFormat();
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
        toast.show(t('remindedToast', { n: r.recipients }));
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
                <Stat label={t('told')} value={fmt.number(d.notified)} hint={t('toldHint', { n: d.notifiedRead })} />
                <Stat label={t('reminded')} value={fmt.number(d.reminded)} hint={d.remindedAt ? t('remindedOn', { when: fmt.dateTime(d.remindedAt) }) : t('notYet')} />
                <Stat label={t('pushes')} value={t('pushesSent', { n: d.pushSent })} hint={t('pushesHint', { failed: d.pushFailed, pending: d.pushPending })} />
                <Stat label={t('opened')} value={t('openedOf', { n: d.opened.accounts, total: d.opened.audienceAccounts })} />
              </div>
              {out && !d.remindedAt ? (
                <span>
                  <Button onClick={() => setConfirm(true)}>{t('remindButton')}</Button>
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
        title={t('remindTitle')}
        description={t('remindDescription')}
        confirmLabel={t('remind')}
        pending={remind.isPending}
        onConfirm={() => remind.mutate()}
      />
    </Card>
  );
}
