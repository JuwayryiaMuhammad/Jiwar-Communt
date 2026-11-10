'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FineDialog, type FineBody } from '@/components/vehicles/fine-dialog';
import { matchesText } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ParkingReportStatus, type StaffParkingReport } from '@/lib/queries';
import ar from '@/messages/ar/safety-parking-reports';
import en from '@/messages/en/safety-parking-reports';

const VIEWS = ['open', 'converted', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];

function ReportDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const report = useQuery({ queryKey: keys.parkingReport(id), queryFn: () => fetchers.parkingReport(id) });
  const [step, setStep] = useState<'close' | 'convert' | null>(null);
  const close = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/parking-reports/{id}/close', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.parkingReportsAll],
      onDone: () => {
        toast.show(t('closed'));
        setStep(null);
      },
    },
  );
  const convert = useAction(
    (body: FineBody) => unwrap(api.POST('/api/v1/staff/parking-reports/{id}/convert', { params: { path: { id } }, body })),
    {
      invalidate: [keys.parkingReportsAll, keys.finesAll],
      onDone: () => {
        toast.show(t('fined'));
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
        title={r ? `${r.reference} · ${r.plate}` : t('report')}
        description={r ? r.location : undefined}
        footer={
          <>
            {open ? <Button onClick={() => setStep('close')}>{t('close')}</Button> : null}
            {open && can('fines.issue') ? (
              <Button variant="primary" onClick={() => setStep('convert')}>
                {t('issueFine')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={report} rows={4}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? <span className="t-secondary"> · {label(r.closeReason)}</span> : null}
                </dd>
                <dt>{t('reportedBy')}</dt>
                <dd>
                  {r.reporter.erased ? t('erased') : r.reporter.fullName} · {fmt.dateTime(r.createdAt)}
                </dd>
                <dt>{t('matches')}</dt>
                <dd>{matchesText(r.matches, { none: t('noMatch'), status: label, list: fmt.list })}</dd>
                {r.note ? (
                  <>
                    <dt>{t('note')}</dt>
                    <dd>{r.note}</dd>
                  </>
                ) : null}
              </dl>
              {r.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={r.photoUrl} target="_blank" rel="noreferrer">
                  {t('openPhoto')}
                </a>
              ) : null}
              <p className="t-secondary">{t('reporterPrivate')}</p>
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={t('closeTitle', { reference: r?.reference ?? '' })}
        description={t('closeDescription')}
        codes={REASON_CODES.parkingReportClose}
        confirmLabel={t('close')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      />
      {r && step === 'convert' ? (
        <FineDialog
          title={t('fineTitle', { reference: r.reference })}
          description={t('fineDescription')}
          initial={{ unitCode: r.matches.length === 1 ? r.matches[0]?.unitCode : undefined, plate: r.plate }}
          confirmLabel={t('fineConfirm')}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('parking_reports.handle');
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(null);
  const status: ParkingReportStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.parkingReports(status), (c) => fetchers.parkingReports(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffParkingReport>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={view === 'open' ? t('emptyOpen') : t('emptyMatch')}
            columns={[
              {
                key: 'ref',
                header: t('col.report'),
                cell: (r) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(r.id)}>
                    {r.reference}
                  </Button>
                ),
              },
              { key: 'plate', header: t('col.plate'), cell: (r) => r.plate },
              { key: 'where', header: t('col.where'), cell: (r) => r.location },
              {
                key: 'matches',
                header: t('col.matches'),
                cell: (r) => matchesText(r.matches, { none: t('noMatch'), status: label, list: fmt.list }),
              },
              { key: 'status', header: t('col.status'), cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'when', header: t('col.reported'), cell: (r) => <span title={fmt.dateTime(r.createdAt)}>{fmt.relative(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ReportDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
