'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, useCommonT, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { localName } from '@/components/management-requests/logic';
import { word } from '@/components/partners/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerComplaint } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-complaints';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-complaints';

type View = 'false' | 'true' | '';

/**
 * Complaints against partners (ADR 0060). Each is a management request on
 * "Partner services": its conversation is there; the decision is here.
 */
export default function PartnerComplaintsPage() {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const [view, setView] = useState<View>('false');
  const list = useCursorList(keys.partnerComplaints(view), (c) => fetchers.partnerComplaints(view, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={[
            { value: 'false', label: t('view.toDecide') },
            { value: 'true', label: t('view.decided') },
            { value: '', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PartnerComplaint>
            rows={list.rows}
            rowKey={(cm) => cm.id}
            empty={view === 'false' ? t('emptyToDecide') : t('empty')}
            columns={[
              {
                key: 'n',
                header: t('col.complaint'),
                cell: (cm) => (
                  <Link className="table__link" href={`/partners/complaints/${cm.id}`}>
                    <span className="ltr">{cm.managementRequestNumber}</span> · <span className="ltr">{cm.requestNumber}</span>
                  </Link>
                ),
              },
              { key: 'p', header: t('col.partner'), cell: (cm) => localName(locale, cm.partner) },
              { key: 'r', header: c('reason'), cell: (cm) => label(cm.reason) },
              { key: 'a', header: t('col.asks'), cell: (cm) => `${label(cm.compensationAsk)}${cm.requestedAmount ? ` · ${f.money(cm.requestedAmount)}` : ''}` },
              { key: 'o', header: t('col.decision'), cell: (cm) => (cm.outcome ? word(codes, 'outcome', cm.outcome) : '—') },
              { key: 't', header: t('col.made'), cell: (cm) => <span title={f.dateTime(cm.createdAt)}>{f.relative(cm.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
