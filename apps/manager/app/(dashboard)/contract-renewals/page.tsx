'use client';

import {
  errorText,
  formatDateTime,
  REASON_CODES,
  unwrap,
  type Schema,
} from '@jiwar/api';
import { QueryState, useAction } from '@jiwar/api/react';
import {
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

type Renewal = Schema<'StaffRenewalView'>;
const KEY = ['contract-renewals'] as const;

/**
 * Tenants asking to renew their lease (ADR 0062). Renew by recording the
 * next lease on the unit's papers (it answers the request), or decline with
 * a reason the tenant sees.
 */
export default function ContractRenewalsPage() {
  const toast = useToast();
  const [declining, setDeclining] = useState<Renewal | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/contract-renewals')),
    refetchInterval: 120_000,
  });
  const decline = useAction(
    (v: { r: Renewal; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/contract-renewals/{id}/decline', {
          params: { path: { id: v.r.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Declined. The tenant is told.');
        setDeclining(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title="Lease renewal requests"
        description="Renew by recording the next lease on the unit's papers, with this request's id; or decline with a reason."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Renewal>
            rows={list.data}
            rowKey={(r) => r.id}
            empty="No renewal request is open"
            emptyHint="A tenant asks from the app, until the lease ends."
            columns={[
              {
                key: 'unit',
                header: 'Unit',
                cell: (r) => (
                  <Link
                    className="table__link"
                    href={`/units/${r.unitId}/papers`}
                  >
                    The unit’s papers
                  </Link>
                ),
              },
              {
                key: 'id',
                header: 'Request',
                cell: (r) => <span className="t-mono">{r.id}</span>,
              },
              {
                key: 'when',
                header: 'Asked',
                cell: (r) => formatDateTime(r.createdAt),
              },
              {
                key: 'act',
                header: '',
                cell: (r) => (
                  <Button size="sm" onClick={() => setDeclining(r)}>
                    Decline
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title="Decline the renewal"
        description="The tenant sees the reason and plans the move out."
        codes={REASON_CODES.contractRenewalDecline}
        confirmLabel="Decline"
        danger
        pending={decline.isPending}
        error={decline.error ? errorText(decline.error) : undefined}
        onConfirm={(reasonCode) =>
          declining && decline.mutate({ r: declining, reasonCode })
        }
      />
    </>
  );
}
