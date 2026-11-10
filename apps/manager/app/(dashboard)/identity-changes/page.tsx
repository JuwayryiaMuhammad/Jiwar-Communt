'use client';

import { ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, PageHeader, ReasonCodeDialog, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/res-identity-changes';
import en from '@/messages/en/res-identity-changes';

type Change = Schema<'IdentityChangeReviewView'>;
const KEY = ['identity-changes'] as const;

/**
 * Name and phone changes residents asked for (ADR 0062). The name is the
 * one on their ID, which the gate checks; the phone is how they log in and
 * no SMS proves it yet. So the resident asks and a manager decides here:
 * check the new value against their documents, then approve or reject with
 * a reason. The value is erased once decided.
 */
export default function IdentityChangesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<Change | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/identity-changes', {
          params: { query: { limit: 100 } },
        }),
      ),
    refetchInterval: 120_000,
  });

  const approve = useAction(
    (change: Change) =>
      unwrap(
        api.POST('/api/v1/identity-changes/{id}/approve', {
          params: { path: { id: change.id } },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => toast.show(t('approved')),
    },
  );
  const reject = useAction(
    (v: { c: Change; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/identity-changes/{id}/reject', {
          params: { path: { id: v.c.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('rejected'));
        setRejecting(null);
      },
    },
  );

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Change>
            rows={list.data?.data}
            rowKey={(row) => row.id}
            empty={t('none')}
            emptyHint={t('noneHint')}
            columns={[
              {
                key: 'who',
                header: t('col.account'),
                cell: (row) => (
                  <Link className="table__link" href={`/residents/${row.accountId}`}>
                    {row.accountType === 'family' ? t('family') : t('resident')}
                  </Link>
                ),
              },
              {
                key: 'field',
                header: t('col.what'),
                cell: (row) => <Badge tone="beige">{row.field === 'name' ? t('name') : t('phone')}</Badge>,
              },
              { key: 'now', header: t('col.now'), cell: (row) => row.currentValue ?? '—' },
              {
                key: 'new',
                header: t('col.asked'),
                cell: (row) => <strong>{row.newValue}</strong>,
              },
              {
                key: 'when',
                header: t('col.when'),
                cell: (row) => f.dateTime(row.createdAt),
              },
              {
                key: 'act',
                header: '',
                cell: (row) => (
                  <span style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(row)}>
                      {c('approve')}
                    </Button>
                    <Button size="sm" onClick={() => setRejecting(row)}>
                      {c('reject')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={t('rejectTitle')}
        description={t('rejectDescription')}
        codes={REASON_CODES.identityChangeReject}
        confirmLabel={c('reject')}
        danger
        pending={reject.isPending}
        error={reject.error ? <ErrorText error={reject.error} /> : undefined}
        onConfirm={(reasonCode) => rejecting && reject.mutate({ c: rejecting, reasonCode })}
      />
    </>
  );
}
