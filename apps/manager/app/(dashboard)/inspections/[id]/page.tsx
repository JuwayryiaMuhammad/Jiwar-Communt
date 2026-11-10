'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, CardBody, CardHeader, PageHeader, ReasonCodeDialog, StatusBadge, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ChecklistRunCard } from '@/components/assets/checklist-run';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/assets-inspections';
import en from '@/messages/en/assets-inspections';

export default function InspectionPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const inspection = useQuery({ queryKey: keys.inspection(id), queryFn: () => fetchers.inspection(id) });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/inspections/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.inspectionsAll],
      onDone: () => {
        toast.show(t('calledOff'));
        setCancelling(false);
      },
    },
  );
  const i = inspection.data;
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/inspections" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('back')}
          </ButtonLink>
        }
        title={
          i ? (
            <span className="row" style={{ gap: 12 }}>
              {t('dueTitle', { date: fmt.day(i.dueOn) })} <StatusBadge status={i.status} />
            </span>
          ) : (
            t('inspection')
          )
        }
        actions={
          i && (i.status === 'scheduled' || i.status === 'in_progress') ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              {t('callOff')}
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
                <CardHeader title={t('inspection')} />
                <CardBody>
                  <dl className="dl">
                    <dt>{t('where')}</dt>
                    <dd>
                      {i.assetId ? (
                        <Link className="table__link" href={`/assets/${i.assetId}`}>
                          {t('theAsset')}
                        </Link>
                      ) : (
                        t('aCommonArea')
                      )}
                    </dd>
                    <dt>{t('started')}</dt>
                    <dd>{i.startedAt ? fmt.dateTime(i.startedAt) : '—'}</dd>
                    <dt>{t('tagScanned')}</dt>
                    <dd>{i.scannedAt ? fmt.dateTime(i.scannedAt) : '—'}</dd>
                    <dt>{t('submittedOn')}</dt>
                    <dd>{i.submittedAt ? fmt.dateTime(i.submittedAt) : '—'}</dd>
                    {i.cancelReason ? (
                      <>
                        <dt>{t('calledOffAt')}</dt>
                        <dd>{label(i.cancelReason)}</dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title={t('findings')} />
                <CardBody>
                  {i.findings.length ? (
                    <ul className="list">
                      {i.findings.map((f) => (
                        <li key={f.ticketId}>
                          <Link className="table__link" href={`/maintenance/${f.ticketId}`}>
                            {t('workOrder')}
                          </Link>{' '}
                          <StatusBadge status={f.ticketStatus} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="t-secondary">{t('none')}</p>
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
        title={t('callOffTitle')}
        codes={REASON_CODES.inspectionCancel}
        confirmLabel={t('callOff')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(c) => cancel.mutate(c)}
      />
    </>
  );
}
