'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FineDialog, type FineBody } from '@/components/vehicles/fine-dialog';
import { matchesText } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ParkingReportStatus, type StaffParkingReport } from '@/lib/queries';

const VIEWS = ['open', 'closed', 'converted', 'all'] as const;
type View = (typeof VIEWS)[number];

function ReportDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { can } = usePermissions();
  const report = useQuery({ queryKey: keys.parkingReport(id), queryFn: () => fetchers.parkingReport(id) });
  const [step, setStep] = useState<'close' | 'convert' | null>(null);
  const close = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/parking-reports/{id}/close', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.parkingReportsAll],
      onDone: () => {
        toast.show('Closed.');
        setStep(null);
      },
    },
  );
  const convert = useAction(
    (body: FineBody) => unwrap(api.POST('/api/v1/staff/parking-reports/{id}/convert', { params: { path: { id } }, body })),
    {
      invalidate: [keys.parkingReportsAll, keys.finesAll],
      onDone: () => {
        toast.show('Fine issued. The unit is told; it never learns who reported.');
        setStep(null);
      },
    },
  );
  const r = report.data;
  const open = r?.status === 'open';
  return (
    <>
      <Dialog
        open={step !== 'convert'}
        wide
        onClose={onClose}
        title={r ? `${r.reference} · ${r.plate}` : 'Parking report'}
        description={r ? r.location : undefined}
        footer={
          <>
            {open ? <Button onClick={() => setStep('close')}>Close</Button> : null}
            {open && can('fines.issue') ? (
              <Button variant="primary" onClick={() => setStep('convert')}>
                Issue a fine
              </Button>
            ) : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={report} rows={4}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? <span className="t-secondary"> · {humanize(r.closeReason)}</span> : null}
                </dd>
                <dt>Reported by</dt>
                <dd>
                  {r.reporter.erased ? 'An erased account' : r.reporter.fullName} · {formatDateTime(r.createdAt)}
                </dd>
                <dt>Matches</dt>
                <dd>{matchesText(r.matches)}</dd>
                {r.note ? (
                  <>
                    <dt>Note</dt>
                    <dd>{r.note}</dd>
                  </>
                ) : null}
              </dl>
              {r.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={r.photoUrl} target="_blank" rel="noreferrer">
                  Open the photo
                </a>
              ) : null}
              <p className="t-secondary">
                The reporter stays yours to know: a fine issued from here carries nothing of this report, not even its photo.
              </p>
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={`Close ${r?.reference ?? ''}?`}
        description="The reporter sees it closed, never why."
        codes={REASON_CODES.parkingReportClose}
        confirmLabel="Close"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      />
      {r && step === 'convert' ? (
        <FineDialog
          title={`A fine from ${r.reference}`}
          description="Issued as any fine: the unit sees the fine, not the report."
          initial={{ unitCode: r.matches.length === 1 ? r.matches[0]?.unitCode : undefined, plate: r.plate }}
          confirmLabel="Issue"
          pending={convert.isPending}
          error={convert.error}
          onSubmit={(body) => convert.mutate(body)}
          onClose={() => setStep(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Residents' reports of wrongly parked vehicles (ADR 0045): security sees
 * who reported and whose plate it is, closes the report or turns it into a
 * fine. The reported unit never learns who reported.
 */
export default function ParkingReportsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('parking_reports.handle');
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(null);
  const status: ParkingReportStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.parkingReports(status), (c) => fetchers.parkingReports(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Parking reports" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Parking reports" description="Oldest first. The reporter learns only that a report was dealt with." />
      <div className="toolbar">
        <Segmented<View>
          label="Reports shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'converted', label: 'Fined' },
            { value: 'closed', label: 'Closed' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffParkingReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={view === 'open' ? 'No report waits' : 'No report matches'}
            columns={[
              {
                key: 'ref',
                header: 'Report',
                cell: (r) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(r.id)}>
                    {r.reference}
                  </Button>
                ),
              },
              { key: 'plate', header: 'Plate', cell: (r) => r.plate },
              { key: 'where', header: 'Where', cell: (r) => r.location },
              { key: 'matches', header: 'Matches', cell: (r) => matchesText(r.matches) },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'when', header: 'Reported', cell: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ReportDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
