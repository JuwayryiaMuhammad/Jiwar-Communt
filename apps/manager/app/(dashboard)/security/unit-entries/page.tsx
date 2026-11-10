'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, PageHeader, Segmented, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RecordEntryDialog, ReportEntryDialog } from '@/components/security/unit-entry-dialogs';
import { api } from '@/lib/api';
import ar from '@/messages/ar/sec-unit-entries';
import en from '@/messages/en/sec-unit-entries';

type Entry = Schema<'StaffUnitEntryView'>;
const VIEWS = ['open', 'reported'] as const;
type View = (typeof VIEWS)[number];

/**
 * Emergency entries into units (ADR 0083): never silent. Recorded with the
 * witnesses and photos before, the unit's people told at once; then the
 * report, once, within a day (the inbox reminds).
 */
export default function UnitEntriesPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const [view, setView] = useState<View>('open');
  const [recording, setRecording] = useState(false);
  const [reporting, setReporting] = useState<Entry | null>(null);
  const list = useQuery({
    queryKey: ['unit-entries', view],
    queryFn: () =>
      unwrap(api.GET('/api/v1/staff/security/unit-entries', { params: { query: { status: view } } })),
  });
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setRecording(true)}>
            {t('recordEntry')}
          </Button>
        }
      />
      <Segmented<View>
        label={t('show')}
        value={view}
        onChange={setView}
        options={[
          { value: 'open', label: t('view.open') },
          { value: 'reported', label: t('view.reported') },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Entry>
            rows={list.data?.data}
            rowKey={(e) => e.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              { key: 'ref', header: t('col.entry'), cell: (e) => <span className="t-mono ltr">{e.reference}</span> },
              { key: 'unit', header: t('col.unit'), cell: (e) => <strong>{e.unitCode}</strong> },
              { key: 'why', header: t('col.why'), cell: (e) => <Badge tone="terracotta">{label(e.reasonCode)}</Badge> },
              { key: 'when', header: t('col.wentIn'), cell: (e) => f.dateTime(e.enteredAt) },
              {
                key: 'who',
                header: t('col.who'),
                cell: (e) => f.list([e.recordedByName ?? '—', ...e.witnessNames.map((n) => n ?? '—')]),
              },
              {
                key: 'found',
                header: t('col.found'),
                cell: (e) => (e.outcome ? label(e.outcome) : <span className="t-secondary">{t('reportDue')}</span>),
              },
              {
                key: 'act',
                header: '',
                cell: (e) =>
                  e.status === 'open' ? (
                    <Button size="sm" variant="primary" onClick={() => setReporting(e)}>
                      {t('report')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {recording ? <RecordEntryDialog onClose={() => setRecording(false)} /> : null}
      {reporting ? <ReportEntryDialog entry={reporting} onClose={() => setReporting(null)} /> : null}
    </>
  );
}
