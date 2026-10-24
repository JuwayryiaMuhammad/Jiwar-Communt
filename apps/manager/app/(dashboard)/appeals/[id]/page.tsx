'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { decisionLine, KIND_TEXT, needsSticker, STATUS_TEXT, subjectHref } from '@/components/appeals/logic';
import { Back } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DecisionAppeal } from '@/lib/queries';

function Decide({ appeal, onClose }: { appeal: DecisionAppeal; onClose: () => void }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<'upheld' | 'overturned'>('upheld');
  const [rationale, setRationale] = useState('');
  const [stickerNumber, setSticker] = useState('');
  const [permitValidUntil, setDay] = useState('');
  const sticker = needsSticker(appeal.kind, outcome);
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/decision-appeals/{id}/decide', {
          params: { path: { id: appeal.id } },
          body: {
            outcome,
            rationale: rationale.trim(),
            ...(sticker && stickerNumber ? { stickerNumber, permitValidUntil } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.decisionAppealsAll],
      onDone: () => {
        toast.show('Decided. The appellant and the unit’s primary were told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Decide this appeal"
      description="Once, with your reasons: the appellant reads them. An overturn runs the decision’s normal approval with all its checks; what one refuses is left to you to follow up."
      onSubmit={() => decide.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={!rationale.trim()}>
            Decide
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Outcome">
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as 'upheld' | 'overturned')}>
              <option value="upheld">Uphold: the decision stands</option>
              <option value="overturned">Overturn the decision</option>
            </Select>
          )}
        </Field>
        <Field label="Your reasons" hint="Write no one’s name.">
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
        </Field>
        {sticker ? (
          <>
            <Field label="Sticker number" hint="As an approval issues it. Without one, the overturn is left to follow up.">
              {(p) => <Input {...p} maxLength={20} value={stickerNumber} onChange={(e) => setSticker(e.target.value.toUpperCase())} />}
            </Field>
            <Field label="Permit’s last day">
              {(p) => <Input {...p} type="date" value={permitValidUntil} onChange={(e) => setDay(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <ErrorAlert error={decide.error} />
      </div>
    </Dialog>
  );
}

/** One decision appeal (ADR 0059), as the deciders read it. */
export default function DecisionAppealPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('appeals.decide');
  const q = useQuery({ queryKey: keys.decisionAppeal(id), queryFn: () => fetchers.decisionAppeal(id), enabled: allowed });
  const [deciding, setDeciding] = useState(false);
  const followed = useAction(
    () => unwrap(api.POST('/api/v1/staff/decision-appeals/{id}/followed-up', { params: { path: { id } } })),
    { invalidate: [keys.decisionAppealsAll], onDone: () => toast.show('Marked followed up.') },
  );
  const back = <Back href="/appeals" label="Decision appeals" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Appeal" />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  const toFollow = a?.decision?.effect === 'follow_up' && !a.decision.followedUpAt;
  const href = a ? subjectHref(a.kind, a.subjectId) : null;
  return (
    <>
      <PageHeader
        back={back}
        title={a ? `${a.reference} · ${KIND_TEXT[a.kind]} · unit ${a.unitCode}` : 'Appeal'}
        actions={
          a ? (
            a.status === 'pending' && !a.ownDecision ? (
              <Button variant="primary" onClick={() => setDeciding(true)}>
                Decide
              </Button>
            ) : toFollow ? (
              <Button variant="primary" loading={followed.isPending} onClick={() => followed.mutate(undefined)}>
                Mark followed up
              </Button>
            ) : null
          ) : null
        }
      />
      <QueryState query={q}>
        {a ? (
          <Card>
            <dl className="dl">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={a.status} /> {STATUS_TEXT[a.status]}
                {a.status === 'pending' && a.ownDecision ? ' · you took the decision: another manager decides' : ''}
              </dd>
              <dt>Decided</dt>
              <dd>{formatDateTime(a.decisionAt)}</dd>
              <dt>Lodged</dt>
              <dd>{formatDateTime(a.lodgedAt)}</dd>
              <dt>Grounds</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{a.grounds ?? 'Cleared at the appellant’s erasure'}</dd>
              {a.attachments.length ? (
                <>
                  <dt>Attachments</dt>
                  <dd>
                    {a.attachments.map((f, i) =>
                      f.url ? (
                        <a key={f.fileId} href={f.url} target="_blank" rel="noreferrer">
                          File {i + 1}{' '}
                        </a>
                      ) : (
                        <span key={f.fileId}>File {i + 1} (gone) </span>
                      ),
                    )}
                  </dd>
                </>
              ) : null}
              {href ? (
                <>
                  <dt>The decision</dt>
                  <dd>
                    <Link href={href}>Open it</Link>
                  </dd>
                </>
              ) : null}
              {a.decision ? (
                <>
                  <dt>Decision</dt>
                  <dd>
                    {decisionLine(a.decision)} · {formatDateTime(a.decision.decidedAt)} ·{' '}
                    {a.decision.decidedBy.roleName ?? a.decision.decidedBy.roleKey}
                  </dd>
                  <dt>Reasons</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
                  {a.decision.followedUpAt ? (
                    <>
                      <dt>Followed up</dt>
                      <dd>{formatDateTime(a.decision.followedUpAt)}</dd>
                    </>
                  ) : null}
                </>
              ) : null}
              {a.takenToBoardAt ? (
                <>
                  <dt>Taken to the board</dt>
                  <dd>{formatDateTime(a.takenToBoardAt)}</dd>
                </>
              ) : null}
            </dl>
            <ErrorAlert error={followed.error} />
          </Card>
        ) : null}
      </QueryState>
      {deciding && a ? <Decide appeal={a} onClose={() => setDeciding(false)} /> : null}
    </>
  );
}
