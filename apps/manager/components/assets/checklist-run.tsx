'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { Badge, Card, CardBody, CardHeader } from '@jiwar/ui';
import type { ChecklistRun } from '@/lib/queries';

/** A checklist as filled: each item, its answer, and the attestation once submitted. */
export function ChecklistRunCard({ run, title = 'Checklist' }: { run: ChecklistRun; title?: string }) {
  return (
    <Card flush>
      <CardHeader title={title} actions={<Badge tone={run.status === 'submitted' ? 'green' : 'beige'}>{humanize(run.status)}</Badge>} />
      <CardBody>
        <ol className="list">
          {run.items.map((i) => (
            <li key={i.id} className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                {i.labelEn}
                {i.required ? '' : <span className="t-secondary"> (optional)</span>}
              </span>
              <span className="row" style={{ gap: 6 }}>
                {i.answer?.result ? <Badge tone={i.answer.result === 'fail' ? 'error' : 'green'}>{humanize(i.answer.result)}</Badge> : null}
                {i.answer?.value ? (
                  <span className="t-num">
                    {i.answer.value} {i.unit ?? ''}
                  </span>
                ) : null}
                {i.answer?.note ? <span className="t-secondary">{i.answer.note}</span> : null}
                {i.answer?.photos.map((p) =>
                  p.url ? (
                    <a key={p.id} className="table__link" href={p.url} target="_blank" rel="noreferrer">
                      Photo
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
            Submitted {formatDateTime(run.submittedAt)} · SHA-256 <span className="t-mono">{run.attestationSha256.slice(0, 16)}…</span>
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
