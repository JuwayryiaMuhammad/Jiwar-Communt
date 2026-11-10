'use client';

import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, CardBody, CardHeader, useLabel } from '@jiwar/ui';
import type { ChecklistRun } from '@/lib/queries';
import ar from '@/messages/ar/assets-inspections';
import en from '@/messages/en/assets-inspections';

/** A checklist as filled: each item, its answer, and the attestation once submitted. */
export function ChecklistRunCard({ run, title }: { run: ChecklistRun; title?: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  return (
    <Card flush>
      <CardHeader title={title ?? t('checklistTitle')} actions={<Badge tone={run.status === 'submitted' ? 'green' : 'beige'}>{label(run.status)}</Badge>} />
      <CardBody>
        <ol className="list">
          {run.items.map((i) => (
            <li key={i.id} className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                {fmt.locale === 'ar' ? i.labelAr || i.labelEn : i.labelEn}
                {i.required ? '' : <span className="t-secondary"> {t('optional')}</span>}
              </span>
              <span className="row" style={{ gap: 6 }}>
                {i.answer?.result ? <Badge tone={i.answer.result === 'fail' ? 'error' : 'green'}>{label(i.answer.result)}</Badge> : null}
                {i.answer?.value ? (
                  <bdi className="t-num">
                    {i.answer.value} {i.unit ?? ''}
                  </bdi>
                ) : null}
                {i.answer?.note ? <span className="t-secondary">{i.answer.note}</span> : null}
                {i.answer?.photos.map((p) =>
                  p.url ? (
                    <a key={p.id} className="table__link" href={p.url} target="_blank" rel="noreferrer">
                      {t('photo')}
                    </a>
                  ) : null,
                )}
                {!i.answer ? <span className="t-secondary">—</span> : null}
              </span>
            </li>
          ))}
        </ol>
        {run.attestationSha256 ? (
          <p className="t-secondary" style={{ marginTop: 12 }}>
            {t('submittedAt', { when: fmt.dateTime(run.submittedAt), hash: `${run.attestationSha256.slice(0, 16)}…` })}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
