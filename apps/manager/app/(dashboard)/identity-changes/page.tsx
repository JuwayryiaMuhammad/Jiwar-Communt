'use client';

import {
  errorText,
  formatDateTime,
  REASON_CODES,
  unwrap,
  type Schema,
} from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  PageHeader,
  ReasonCodeDialog,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';

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
    (c: Change) =>
      unwrap(
        api.POST('/api/v1/identity-changes/{id}/approve', {
          params: { path: { id: c.id } },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => toast.show('Changed. The resident is told.'),
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
        toast.show('Rejected. The resident is told why.');
        setRejecting(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        title="Name and phone changes"
        description="Residents ask; you check the new value against their documents, then approve or reject. Nothing changes until you do."
      />
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Change>
            rows={list.data?.data}
            rowKey={(c) => c.id}
            empty="No change waits"
            emptyHint="A resident asks from the app, after confirming it is them."
            columns={[
              {
                key: 'who',
                header: 'Account',
                cell: (c) => (
                  <Link
                    className="table__link"
                    href={`/residents/${c.accountId}`}
                  >
                    {c.accountType === 'family' ? 'Family member' : 'Resident'}
                  </Link>
                ),
              },
              {
                key: 'field',
                header: 'What',
                cell: (c) => (
                  <Badge tone="beige">
                    {c.field === 'name' ? 'Name' : 'Phone'}
                  </Badge>
                ),
              },
              { key: 'now', header: 'Now', cell: (c) => c.currentValue ?? '—' },
              {
                key: 'new',
                header: 'Asked for',
                cell: (c) => <strong>{c.newValue}</strong>,
              },
              {
                key: 'when',
                header: 'Asked',
                cell: (c) => formatDateTime(c.createdAt),
              },
              {
                key: 'act',
                header: '',
                cell: (c) => (
                  <span style={{ display: 'flex', gap: 8 }}>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={approve.isPending}
                      onClick={() => approve.mutate(c)}
                    >
                      Approve
                    </Button>
                    <Button size="sm" onClick={() => setRejecting(c)}>
                      Reject
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
        title="Reject the change"
        description="The resident sees the reason; the value they asked for is erased."
        codes={REASON_CODES.identityChangeReject}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={reject.error ? errorText(reject.error) : undefined}
        onConfirm={(reasonCode) =>
          rejecting && reject.mutate({ c: rejecting, reasonCode })
        }
      />
    </>
  );
}
