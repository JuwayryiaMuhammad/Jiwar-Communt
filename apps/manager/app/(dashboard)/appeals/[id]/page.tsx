'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { decisionLine, kindText, needsSticker, statusText, subjectHref } from '@/components/appeals/logic';
import { Back } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DecisionAppeal } from '@/lib/queries';
import ar from '@/messages/ar/money-appeals';
import en from '@/messages/en/money-appeals';

function Decide({ appeal, onClose }: { appeal: DecisionAppeal; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('decidedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('decideTitle')}
      description={t('decideDescription')}
      onSubmit={() => decide.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={!rationale.trim()}>
            {t('decide')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('outcome')}>
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as 'upheld' | 'overturned')}>
              <option value="upheld">{t('outcome.upheld')}</option>
              <option value="overturned">{t('outcome.overturned')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('yourReasons')} hint={t('yourReasonsHint')}>
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
        </Field>
        {sticker ? (
          <>
            <Field label={t('stickerNumber')} hint={t('stickerHint')}>
              {(p) => <Input {...p} maxLength={20} value={stickerNumber} onChange={(e) => setSticker(e.target.value.toUpperCase())} />}
            </Field>
            <Field label={t('permitLastDay')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('appeals.decide');
  const q = useQuery({ queryKey: keys.decisionAppeal(id), queryFn: () => fetchers.decisionAppeal(id), enabled: allowed });
  const [deciding, setDeciding] = useState(false);
  const followed = useAction(
    () => unwrap(api.POST('/api/v1/staff/decision-appeals/{id}/followed-up', { params: { path: { id } } })),
    { invalidate: [keys.decisionAppealsAll], onDone: () => toast.show(t('markedFollowed')) },
  );
  const back = <Back href="/appeals" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('appeal')} />
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
        title={a ? t('detailTitle', { reference: a.reference, kind: kindText(t, a.kind), unit: a.unitCode }) : t('appeal')}
        actions={
          a ? (
            a.status === 'pending' && !a.ownDecision ? (
              <Button variant="primary" onClick={() => setDeciding(true)}>
                {t('decide')}
              </Button>
            ) : toFollow ? (
              <Button variant="primary" loading={followed.isPending} onClick={() => followed.mutate(undefined)}>
                {t('markFollowed')}
              </Button>
            ) : null
          ) : null
        }
      />
      <QueryState query={q}>
        {a ? (
          <Card>
            <dl className="dl">
              <dt>{t('status')}</dt>
              <dd>
                <StatusBadge status={a.status} /> {statusText(t, a.status)}
                {a.status === 'pending' && a.ownDecision ? <> · {t('ownPending')}</> : null}
              </dd>
              <dt>{t('decided')}</dt>
              <dd>{fmt.dateTime(a.decisionAt)}</dd>
              <dt>{t('lodged')}</dt>
              <dd>{fmt.dateTime(a.lodgedAt)}</dd>
              <dt>{t('grounds')}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{a.grounds ?? t('groundsErased')}</dd>
              {a.attachments.length ? (
                <>
                  <dt>{t('attachments')}</dt>
                  <dd>
                    {a.attachments.map((f, i) =>
                      f.url ? (
                        <a key={f.fileId} href={f.url} target="_blank" rel="noreferrer">
                          {t('file', { n: i + 1 })}{' '}
                        </a>
                      ) : (
                        <span key={f.fileId}>{t('fileGone', { n: i + 1 })} </span>
                      ),
                    )}
                  </dd>
                </>
              ) : null}
              {href ? (
                <>
                  <dt>{t('theDecision')}</dt>
                  <dd>
                    <Link href={href}>{t('openIt')}</Link>
                  </dd>
                </>
              ) : null}
              {a.decision ? (
                <>
                  <dt>{t('decision')}</dt>
                  <dd>
                    {decisionLine(a.decision, t)} · {fmt.dateTime(a.decision.decidedAt)} · {a.decision.decidedBy.roleName ?? label(a.decision.decidedBy.roleKey)}
                  </dd>
                  <dt>{t('reasons')}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
                  {a.decision.followedUpAt ? (
                    <>
                      <dt>{t('followedUp')}</dt>
                      <dd>{fmt.dateTime(a.decision.followedUpAt)}</dd>
                    </>
                  ) : null}
                </>
              ) : null}
              {a.takenToBoardAt ? (
                <>
                  <dt>{t('takenToBoard')}</dt>
                  <dd>{fmt.dateTime(a.takenToBoardAt)}</dd>
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
