'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { OUTCOME_TEXT } from '@/components/partners/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerComplaint } from '@/lib/queries';

type View = 'false' | 'true' | '';

/**
 * Complaints against partners (ADR 0060). Each is a management request on
 * "Partner services": its conversation is there; the decision is here.
 */
export default function PartnerComplaintsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const [view, setView] = useState<View>('false');
  const list = useCursorList(keys.partnerComplaints(view), (c) => fetchers.partnerComplaints(view, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Partner complaints" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Partner complaints"
        description="What residents complained of about a partner, and the compensation they asked. Nothing is paid through Jiwar: a credit note is issued in Finance."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Complaints shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'false', label: 'To decide' },
            { value: 'true', label: 'Decided' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartnerComplaint>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={view === 'false' ? 'Nothing to decide' : 'No complaint'}
            columns={[
              {
                key: 'n',
                header: 'Complaint',
                cell: (c) => (
                  <Link className="table__link" href={`/partners/complaints/${c.id}`}>
                    {c.managementRequestNumber} · {c.requestNumber}
                  </Link>
                ),
              },
              { key: 'p', header: 'Partner', cell: (c) => c.partner.nameEn },
              { key: 'r', header: 'Reason', cell: (c) => humanize(c.reason) },
              { key: 'a', header: 'Asks', cell: (c) => `${humanize(c.compensationAsk)}${c.requestedAmount ? ` · ${c.requestedAmount} EGP` : ''}` },
              { key: 'o', header: 'Decision', cell: (c) => (c.outcome ? OUTCOME_TEXT[c.outcome] : '—') },
              { key: 't', header: 'Made', cell: (c) => <span title={formatDateTime(c.createdAt)}>{relativeTime(c.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
