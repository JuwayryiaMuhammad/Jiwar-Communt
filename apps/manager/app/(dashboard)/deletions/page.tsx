'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, PageHeader, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EraseDialog } from '@/components/accounts/erase-dialog';
import { BLOCKER_TEXT } from '@/components/accounts/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Erasure } from '@/lib/queries';

/**
 * Accounts that asked to be deleted (ADR 0023, 0036). A request cools off
 * for 14 days, then the system erases the account by itself unless
 * something blocks it; a blocked one waits here for a manager to clear the
 * blocker and erase, or to close the request.
 */
export default function DeletionsPage() {
  const toast = useToast();
  const { can } = usePermissions();
  const [erasing, setErasing] = useState<Erasure | null>(null);
  const [closing, setClosing] = useState<Erasure | null>(null);
  const list = useCursorList(keys.erasures, (c) => fetchers.erasures(c), { refetchInterval: 120_000 });
  const rows = list.rows ?? [];

  // The queue names accounts by id; their names come from each account, for a role that may read them.
  const names = useQueries({
    queries: rows.map((e) => ({
      queryKey: keys.account(e.accountId),
      queryFn: () => fetchers.account(e.accountId),
      enabled: can('accounts.read'),
      staleTime: 300_000,
    })),
  });
  const nameOf = (e: Erasure) => {
    const account = names[rows.indexOf(e)]?.data;
    return account?.fullName ?? 'This person';
  };

  const close = useAction(
    (v: { e: Erasure; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/erasures/{id}/close', { params: { path: { id: v.e.id } }, body: { reasonCode: v.reasonCode } })),
    {
      invalidate: [keys.erasures],
      onDone: () => {
        toast.show('Request closed. The account stays as it is.');
        setClosing(null);
      },
    },
  );

  const now = Date.now();
  const ready = (e: Erasure) => e.status === 'queued' || new Date(e.effectiveAt).getTime() <= now;

  return (
    <>
      <PageHeader
        title="Deletion requests"
        description="Accounts that asked to be deleted. After a 14-day cooling-off the system erases an account by itself; one that something blocks waits here for you."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Erasure>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty="No deletion request is open"
            emptyHint="A resident asks from the app, or management asks for them from their account page."
            columns={[
              {
                key: 'account',
                header: 'Account',
                cell: (e) =>
                  can('accounts.read') ? (
                    <Link className="table__link" href={`/accounts/${e.accountId}`}>
                      {nameOf(e)}
                    </Link>
                  ) : (
                    <span className="t-mono">{e.accountId.slice(0, 8)}</span>
                  ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (e) =>
                  e.status === 'queued' ? (
                    <Badge tone="terracotta">Waiting for you</Badge>
                  ) : ready(e) ? (
                    <Badge tone="beige">Due: the system erases it shortly</Badge>
                  ) : (
                    <Badge tone="beige">Cooling off</Badge>
                  ),
              },
              {
                key: 'when',
                header: 'Cooling-off ends',
                cell: (e) => (
                  <span title={`Asked ${formatDateTime(e.requestedAt)}`} style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(e.effectiveAt)}
                    {e.daysOverdue > 0 ? <span className="t-secondary"> · {e.daysOverdue} d ago</span> : null}
                  </span>
                ),
              },
              { key: 'by', header: 'Asked by', cell: (e) => (e.assisted ? 'Management, for them' : 'The person') },
              {
                key: 'blockers',
                header: 'What blocks it',
                cell: (e) => {
                  const all = [...new Set([...e.blockers, ...(e.onLegalHold ? ['legal_hold'] : [])])];
                  return all.length ? (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {all.map((b) => (
                        <li key={b}>{BLOCKER_TEXT[b] ?? humanize(b)}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="t-secondary">Nothing known</span>
                  );
                },
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (e) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    {ready(e) ? (
                      <Button size="sm" variant="danger" onClick={() => setErasing(e)}>
                        Erase…
                      </Button>
                    ) : null}
                    {e.status === 'queued' ? (
                      <Button size="sm" onClick={() => setClosing(e)}>
                        Close request
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {erasing ? <EraseDialog erasure={erasing} name={nameOf(erasing)} onClose={() => setErasing(null)} /> : null}
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => {
          setClosing(null);
          close.reset();
        }}
        title={closing ? `Close ${nameOf(closing)}'s deletion request?` : ''}
        description="The account is not erased and keeps working. The person is told, and may ask again later."
        codes={REASON_CODES.deletionClose}
        confirmLabel="Close request"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => closing && close.mutate({ e: closing, reasonCode })}
      />
    </>
  );
}
