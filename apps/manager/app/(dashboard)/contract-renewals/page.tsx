'use client';

import { ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  ReasonCodeDialog,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/contracts';
import en from '@/messages/en/contracts';

type Renewal = Schema<'StaffRenewalView'>;
const KEY = ['contract-renewals'] as const;

/**
 * Tenants asking to renew their lease (ADR 0062). Renew by recording the
 * next lease on the unit's papers (it answers the request), or decline with
 * a reason the tenant sees.
 */
export default function ContractRenewalsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
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
        toast.show(t('declinedToast'));
        setDeclining(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title={t('renewalsTitle')}
        description={t('renewalsDescription')}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Renewal>
            rows={list.data}
            rowKey={(r) => r.id}
            empty={t('renewalsEmpty')}
            emptyHint={t('renewalsEmptyHint')}
            columns={[
              {
                key: 'unit',
                header: c('unit'),
                cell: (r) => (
                  <Link
                    className="table__link"
                    href={`/units/${r.unitId}/papers`}
                  >
                    {t('unitPapers')}
                  </Link>
                ),
              },
              {
                key: 'id',
                header: t('request'),
                cell: (r) => <span className="t-mono ltr">{r.id}</span>,
              },
              {
                key: 'when',
                header: t('asked'),
                cell: (r) => f.dateTime(r.createdAt),
              },
              {
                key: 'act',
                header: '',
                cell: (r) => (
                  <Button size="sm" onClick={() => setDeclining(r)}>
                    {t('decline')}
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
        title={t('declineTitle')}
        description={t('declineDescription')}
        codes={REASON_CODES.contractRenewalDecline}
        confirmLabel={t('decline')}
        danger
        pending={decline.isPending}
        error={decline.error ? <ErrorText error={decline.error} /> : undefined}
        onConfirm={(reasonCode) =>
          declining && decline.mutate({ r: declining, reasonCode })
        }
      />
    </>
  );
}
