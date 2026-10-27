'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, ButtonLink, Card, CardBody, CardHeader, PageHeader, ReasonCodeDialog, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ChecklistRunCard } from '@/components/assets/checklist-run';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';

export default function InspectionPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const inspection = useQuery({ queryKey: keys.inspection(id), queryFn: () => fetchers.inspection(id) });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/inspections/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.inspectionsAll],
      onDone: () => {
        toast.show('Called off.');
        setCancelling(false);
      },
    },
  );
  const i = inspection.data;
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/inspections" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Inspections
          </ButtonLink>
        }
        title={i ? <span className="row" style={{ gap: 12 }}>Inspection due {formatDate(i.dueOn)} <StatusBadge status={i.status} /></span> : 'Inspection'}
        actions={
          i && (i.status === 'scheduled' || i.status === 'in_progress') ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Call off
            </Button>
          ) : undefined
        }
      />
      <QueryState query={inspection}>
        {i ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <ChecklistRunCard run={i.checklist} />
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title="Inspection" />
                <CardBody>
                  <dl className="dl">
                    <dt>Where</dt>
                    <dd>
                      {i.assetId ? (
                        <Link className="table__link" href={`/assets/${i.assetId}`}>
                          The asset
                        </Link>
                      ) : (
                        'A common area'
                      )}
                    </dd>
                    <dt>Started</dt>
                    <dd>{i.startedAt ? formatDateTime(i.startedAt) : '—'}</dd>
                    <dt>Tag scanned</dt>
                    <dd>{i.scannedAt ? formatDateTime(i.scannedAt) : '—'}</dd>
                    <dt>Submitted</dt>
                    <dd>{i.submittedAt ? formatDateTime(i.submittedAt) : '—'}</dd>
                    {i.cancelReason ? (
                      <>
                        <dt>Called off</dt>
                        <dd>{humanize(i.cancelReason)}</dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title="Findings" />
                <CardBody>
                  {i.findings.length ? (
                    <ul className="list">
                      {i.findings.map((f) => (
                        <li key={f.ticketId}>
                          <Link className="table__link" href={`/maintenance/${f.ticketId}`}>
                            Work order
                          </Link>{' '}
                          <StatusBadge status={f.ticketStatus} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="t-secondary">None.</p>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Call the inspection off"
        codes={REASON_CODES.inspectionCancel}
        confirmLabel="Call off"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(c) => cancel.mutate(c)}
      />
    </>
  );
}
