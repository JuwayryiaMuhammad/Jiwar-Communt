'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, PageHeader, Select, useCommonT, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { CompensationDecision } from '@/components/experience/compensation-decision';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Compensation } from '@/lib/queries';
import ar from '@/messages/ar/experience-cases';
import en from '@/messages/en/experience-cases';

type Status = 'proposed' | 'approved' | 'rejected' | '';

/**
 * The compensations (ADR 0082), the oldest first: who decides each now (the
 * manager, or the board above its binding limit), decided here once.
 */
export default function CompensationsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const [status, setStatus] = useState<Status>('proposed');
  const list = useCursorList(keys.compensations({ status }), (cursor) => fetchers.compensations({ status }, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('compensationsTitle')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('compensationsTitle')}
        description={t('compensationsDescription')}
      />
      <div className="toolbar">
        <Field label={c('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="">{t('anyStatus')}</option>
              <option value="proposed">{t('status.proposed')}</option>
              <option value="approved">{t('status.approved')}</option>
              <option value="rejected">{t('status.rejected')}</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Compensation>
            rows={list.rows}
            rowKey={(x) => x.id}
            empty={t('compensationsEmpty')}
            columns={[
              { key: 'at', header: t('proposed'), width: 170, cell: (x) => f.dateTime(x.proposedAt) },
              {
                key: 'case',
                header: t('case'),
                cell: (x) => (
                  <Link className="table__link" href={`/experience/cases/${x.caseId}`}>
                    {t('openCaseLink')}
                  </Link>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (x) => `${label(x.kind)}${x.amount ? ` · ${f.money(x.amount)}` : ''}` },
              { key: 'who', header: t('decides'), cell: (x) => (x.authority ? label(x.authority.decider) : '—') },
              { key: 'status', header: c('status'), cell: (x) => <Badge>{label(x.rejectReason ?? x.status)}</Badge> },
              { key: 'decide', header: '', cell: (x) => (can('experience.compensate') ? <CompensationDecision compensation={x} unitId={x.unitId} /> : null) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
