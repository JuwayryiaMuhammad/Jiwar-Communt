'use client';

import { formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, PageHeader, Segmented } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RecordEntryDialog, ReportEntryDialog } from '@/components/security/unit-entry-dialogs';
import { api } from '@/lib/api';

type Entry = Schema<'StaffUnitEntryView'>;
const VIEWS = ['open', 'reported'] as const;
type View = (typeof VIEWS)[number];

/**
 * Emergency entries into units (ADR 0083): never silent. Recorded with the
 * witnesses and photos before, the unit's people told at once; then the
 * report, once, within a day (the inbox reminds).
 */
export default function UnitEntriesPage() {
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
        title="Emergency entries"
        description="Every time staff went into a unit without its owner: why, who, and what they found."
        actions={
          <Button variant="primary" onClick={() => setRecording(true)}>
            Record an entry
          </Button>
        }
      />
      <Segmented<View>
        label="Show"
        value={view}
        onChange={setView}
        options={[
          { value: 'open', label: 'Report due' },
          { value: 'reported', label: 'Reported' },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Entry>
            rows={list.data?.data}
            rowKey={(e) => e.id}
            empty="No entry here"
            emptyHint="Record one as soon as staff are out of the unit."
            columns={[
              { key: 'ref', header: 'Entry', cell: (e) => <span className="t-mono">{e.reference}</span> },
              { key: 'unit', header: 'Unit', cell: (e) => <strong>{e.unitCode}</strong> },
              { key: 'why', header: 'Why', cell: (e) => <Badge tone="terracotta">{e.reasonCode.replace(/_/g, ' ')}</Badge> },
              { key: 'when', header: 'Went in', cell: (e) => formatDateTime(e.enteredAt) },
              {
                key: 'who',
                header: 'Who',
                cell: (e) => [e.recordedByName ?? '—', ...e.witnessNames.map((n) => n ?? '—')].join(', '),
              },
              {
                key: 'found',
                header: 'Found',
                cell: (e) => (e.outcome ? e.outcome.replace(/_/g, ' ') : <span className="t-secondary">Report due</span>),
              },
              {
                key: 'act',
                header: '',
                cell: (e) =>
                  e.status === 'open' ? (
                    <Button size="sm" variant="primary" onClick={() => setReporting(e)}>
                      Report
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
