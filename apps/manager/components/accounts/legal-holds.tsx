'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, ReasonDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type LegalHold } from '@/lib/queries';

/**
 * Legal holds (ADR 0023): an obligation to keep the account's data. While
 * one is active the account cannot be erased; the person learns their
 * deletion is on hold, never why. The note is the manager's record.
 */
export function LegalHolds({ accountId }: { accountId: string }) {
  const toast = useToast();
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const key = keys.accountPart(accountId, 'legal-holds');
  const holds = useQuery({ queryKey: key, queryFn: () => fetchers.legalHolds(accountId) });
  const refresh = [key, keys.erasures];

  const place = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/accounts/{id}/legal-holds', { params: { path: { id: accountId } }, body: reason })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Legal hold placed. The account cannot be erased while it stands.');
        setPlacing(false);
      },
    },
  );
  const release = useAction(
    (v: { hold: LegalHold; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/legal-holds/{id}/release', {
          params: { path: { id: v.hold.id } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Legal hold released.');
        setReleasing(null);
      },
    },
  );

  return (
    <Card flush>
      <CardHeader
        title="Legal holds"
        actions={
          <Button size="sm" onClick={() => setPlacing(true)}>
            Place a hold
          </Button>
        }
      />
      <QueryState query={holds} rows={2}>
        <DataTable<LegalHold>
          rows={holds.data?.data}
          rowKey={(h) => h.id}
          empty="No legal hold"
          emptyHint="Place one when the law requires keeping this account's data: a dispute, a regulator's request, an audit."
          columns={[
            { key: 'reason', header: 'Reason', cell: (h) => humanize(h.reasonCode) },
            { key: 'placed', header: 'Placed', cell: (h) => formatDateTime(h.placedAt) },
            {
              key: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (h) => (
                <Button size="sm" onClick={() => setReleasing(h)}>
                  Release
                </Button>
              ),
            },
          ]}
        />
      </QueryState>
      <ReasonDialog
        open={placing}
        onClose={() => {
          setPlacing(false);
          place.reset();
        }}
        title="Place a legal hold?"
        description="The account's data must be kept: it cannot be erased, by the person or by management, until the hold is released. The person is told their deletion is on hold, never why."
        codes={REASON_CODES.legalHold}
        textLabel="Note for the record"
        textHint="Kept with the hold for management. The person is never told why."
        confirmLabel="Place hold"
        pending={place.isPending}
        error={<ErrorAlert error={place.error} />}
        onConfirm={(reason) => place.mutate(reason)}
      />
      <ReasonDialog
        open={releasing !== null}
        onClose={() => {
          setReleasing(null);
          release.reset();
        }}
        title="Release this legal hold?"
        description="Once no hold is left, a queued deletion of this account can be carried out."
        codes={REASON_CODES.legalHoldRelease}
        textLabel="Note for the record"
        textHint="Kept with the hold for management. The person is never told why."
        confirmLabel="Release hold"
        pending={release.isPending}
        error={<ErrorAlert error={release.error} />}
        onConfirm={(reason) => releasing && release.mutate({ hold: releasing, ...reason })}
      />
    </Card>
  );
}
