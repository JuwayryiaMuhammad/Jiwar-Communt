'use client';

import { formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { download } from '@/lib/download';

type Inspection = Schema<'StaffPermitInspectionView'>;
const VIEWS = ['asked', 'passed', 'failed'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['permit-inspections'] as const;

const FINDING_LABELS: Record<string, string> = {
  works_unfinished: 'Works unfinished',
  common_areas_damaged: 'Common areas damaged',
  debris_left: 'Debris left',
  safety_issue: 'A safety issue',
  other: 'Other',
};

/**
 * Finished works to inspect (ADR 0063). Pass them, with photos, and the
 * requester gets the completion certificate; or fail them with what is
 * wrong, and they ask again once it is fixed.
 */
export default function PermitInspectionsPage() {
  const [view, setView] = useState<View>('asked');
  const [deciding, setDeciding] = useState<Inspection | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/permit-inspections', { params: { query: { status: view } } })),
    refetchInterval: 120_000,
  });
  return (
    <>
      <PageHeader
        title="Works inspections"
        description="Units asking for their finished works to be inspected. A pass issues the completion certificate."
      />
      <Segmented<View>
        label="Show"
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Inspection>
            rows={list.data}
            rowKey={(i) => i.id}
            empty="No inspection here"
            emptyHint="The requester of an approved works permit asks from the app."
            columns={[
              {
                key: 'permit',
                header: 'Permit',
                cell: (i) => (
                  <Link className="table__link" href={`/permits/${i.permitId}`}>
                    {i.permitReference}
                  </Link>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (i) => i.unitCode },
              { key: 'cycle', header: 'Round', cell: (i) => i.cycle },
              { key: 'asked', header: 'Asked', cell: (i) => formatDateTime(i.requestedAt) },
              {
                key: 'act',
                header: '',
                cell: (i) =>
                  i.status === 'asked' ? (
                    <Button size="sm" variant="primary" onClick={() => setDeciding(i)}>
                      Decide
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
                      Certificate {i.certificateNumber}
                    </Button>
                  ) : (
                    <span>
                      {i.findings.map((f) => (
                        <Badge key={f} tone="beige">
                          {FINDING_LABELS[f] ?? f}
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
        toast.show(r.status === 'passed' ? `Passed: ${r.certificateNumber} issued.` : 'Failed. The requester is told.');
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
      title={`Inspect ${inspection.permitReference}, unit ${inspection.unitCode}`}
      description="One to five photos of the finished works. Decided once."
      onSubmit={() => decide.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={!ready}>
            {outcome === 'passed' ? 'Pass and issue the certificate' : 'Fail'}
          </Button>
        </>
      }
    >
      <ErrorAlert error={decide.error} />
      <div className="form">
        <Segmented<'passed' | 'failed'>
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'passed', label: 'Complete' },
            { value: 'failed', label: 'Not complete' },
          ]}
        />
        {outcome === 'failed' ? (
          <fieldset className="form">
            <legend>What is wrong</legend>
            {REASON_CODES.worksFinding.map((f) => (
              <label key={f} className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={findings.includes(f)} onChange={() => toggle(f)} />
                {FINDING_LABELS[f] ?? f}
              </label>
            ))}
          </fieldset>
        ) : null}
        <FileUpload
          purpose="works_inspection_photo"
          label={photos.length ? `${photos.length} photo(s) — add another` : 'Add a photo'}
          disabled={photos.length >= 5}
          onUploaded={(id) => setPhotos([...photos, id])}
        />
      </div>
    </Dialog>
  );
}
