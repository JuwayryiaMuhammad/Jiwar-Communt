'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import ar from '@/messages/ar/places-fit-out';
import en from '@/messages/en/places-fit-out';

type Inspection = Schema<'StaffPermitInspectionView'>;
const VIEWS = ['asked', 'passed', 'failed'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['permit-inspections'] as const;

/** The findings this page words itself (catalog keys `finding.<code>`); another code takes the shared words. */
const FINDINGS = ['works_unfinished', 'common_areas_damaged', 'debris_left', 'safety_issue', 'other'] as const;
const FINDING_LABELS = {
  en: Object.fromEntries(FINDINGS.map((f) => [f, en[`finding.${f}`]])),
  ar: Object.fromEntries(FINDINGS.map((f) => [f, ar[`finding.${f}`]])),
};

/**
 * Finished works to inspect (ADR 0063). Pass them, with photos, and the
 * requester gets the completion certificate; or fail them with what is
 * wrong, and they ask again once it is fixed.
 */
export default function PermitInspectionsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const finding = useLabel(FINDING_LABELS);
  const [view, setView] = useState<View>('asked');
  const [deciding, setDeciding] = useState<Inspection | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/permit-inspections', { params: { query: { status: view } } })),
    refetchInterval: 120_000,
  });
  return (
    <>
      <PageHeader title={t('insp.title')} description={t('insp.description')} />
      <Segmented<View>
        label={t('insp.show')}
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: t(`insp.view.${v}`) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Inspection>
            rows={list.data}
            rowKey={(i) => i.id}
            empty={t('insp.empty')}
            emptyHint={t('insp.emptyHint')}
            columns={[
              {
                key: 'permit',
                header: t('col.permit'),
                cell: (i) => (
                  <Link className="table__link" href={`/permits/${i.permitId}`}>
                    {i.permitReference}
                  </Link>
                ),
              },
              { key: 'unit', header: t('col.unit'), cell: (i) => i.unitCode },
              { key: 'cycle', header: t('col.round'), cell: (i) => fmt.number(i.cycle) },
              { key: 'asked', header: t('col.asked'), cell: (i) => fmt.dateTime(i.requestedAt) },
              {
                key: 'act',
                header: '',
                cell: (i) =>
                  i.status === 'asked' ? (
                    <Button size="sm" variant="primary" onClick={() => setDeciding(i)}>
                      {t('insp.decide')}
                    </Button>
                  ) : i.status === 'passed' ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        download(
                          `/api/v1/staff/permit-inspections/${i.id}/certificate`,
                          {},
                          `${i.certificateNumber ?? 'certificate'}.pdf`,
                        )
                      }
                    >
                      {t('insp.certificate', { number: i.certificateNumber ?? '' })}
                    </Button>
                  ) : (
                    <span>
                      {i.findings.map((f) => (
                        <Badge key={f} tone="beige">
                          {finding(f)}
                        </Badge>
                      ))}
                    </span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {deciding ? <DecideDialog inspection={deciding} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}

function DecideDialog({ inspection, onClose }: { inspection: Inspection; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const finding = useLabel(FINDING_LABELS);
  const toast = useToast();
  const [outcome, setOutcome] = useState<'passed' | 'failed'>('passed');
  const [findings, setFindings] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/permit-inspections/{id}/decide', {
          params: { path: { id: inspection.id } },
          body: { outcome, photoFileIds: photos, ...(outcome === 'failed' ? { findings } : {}) },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: (r) => {
        toast.show(r.status === 'passed' ? t('insp.passedToast', { number: r.certificateNumber ?? '' }) : t('insp.failedToast'));
        onClose();
      },
    },
  );
  const toggle = (f: string) => setFindings(findings.includes(f) ? findings.filter((x) => x !== f) : [...findings, f]);
  const ready = photos.length > 0 && (outcome === 'passed' || findings.length > 0);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('insp.dialogTitle', { reference: inspection.permitReference, unit: inspection.unitCode })}
      description={t('insp.dialogDescription')}
      onSubmit={() => decide.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={!ready}>
            {outcome === 'passed' ? t('insp.pass') : t('insp.fail')}
          </Button>
        </>
      }
    >
      <ErrorAlert error={decide.error} />
      <div className="form">
        <Segmented<'passed' | 'failed'>
          label={t('insp.outcome')}
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'passed', label: t('insp.outcome.passed') },
            { value: 'failed', label: t('insp.outcome.failed') },
          ]}
        />
        {outcome === 'failed' ? (
          <fieldset className="form">
            <legend>{t('insp.whatIsWrong')}</legend>
            {REASON_CODES.worksFinding.map((f) => (
              <label key={f} className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={findings.includes(f)} onChange={() => toggle(f)} />
                {finding(f)}
              </label>
            ))}
          </fieldset>
        ) : null}
        <FileUpload
          purpose="works_inspection_photo"
          label={photos.length ? t('insp.photos', { count: photos.length }) : t('insp.addPhoto')}
          disabled={photos.length >= 5}
          onUploaded={(id) => setPhotos([...photos, id])}
        />
      </div>
    </Dialog>
  );
}
