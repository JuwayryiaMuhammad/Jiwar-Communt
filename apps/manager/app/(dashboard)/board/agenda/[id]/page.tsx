'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-agenda';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-agenda';
import codesEn from '@/messages/en/gov-codes';

type Outcome = 'accepted' | 'declined';

/** A member answers a proposal once: accepted, or declined with its code; a note to the proposer either way. */
function Decide({ id, outcome, onClose }: { id: string; outcome: Outcome; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/agenda-proposals/{id}/decide', {
          params: { path: { id } },
          body: {
            outcome,
            ...(outcome === 'declined' ? { reasonCode } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(outcome === 'accepted' ? t('acceptedToast') : t('declinedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={outcome === 'accepted' ? t('acceptTitle') : t('declineTitle')}
      description={t('decideDescription')}
      onSubmit={() => decide.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={outcome === 'declined' && !reasonCode}>
            {outcome === 'accepted' ? t('accept') : t('decline')}
          </Button>
        </>
      }
    >
      <div className="form">
        {outcome === 'declined' ? (
          <Field label={t('why')} error={fieldError(decide.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">{t('chooseReason')}</option>
                {REASON_CODES.agendaDecline.map((code) => (
                  <option key={code} value={code}>
                    {label(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('note')} error={fieldError(decide.error, 'note')}>
          {(p) => <Textarea {...p} rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={decide.error} />
      </div>
    </Dialog>
  );
}

/** An owner's agenda proposal as the board reads it (ADR 0059): its words, never who wrote them. */
export default function BoardAgendaProposalPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [deciding, setDeciding] = useState<Outcome | null>(null);
  const q = useQuery({ queryKey: keys.boardAgendaProposal(id), queryFn: () => fetchers.boardAgendaProposal(id), enabled: allowed });
  const back = <Back href="/board/agenda" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('proposal')} />
        <ForbiddenState />
      </>
    );
  const p = q.data;
  return (
    <>
      <PageHeader
        back={back}
        title={p?.title ?? t('proposal')}
        actions={
          p?.status === 'open' ? (
            <span className="row" style={{ gap: 8 }}>
              <Button variant="primary" onClick={() => setDeciding('accepted')}>
                {t('accept')}
              </Button>
              <Button onClick={() => setDeciding('declined')}>{t('decline')}</Button>
            </span>
          ) : null
        }
      />
      <QueryState query={q}>
        {p ? (
          <Card>
            <dl className="dl">
              <dt>{c('status')}</dt>
              <dd>
                <StatusBadge status={p.status} /> {codeText(g, 'agendaStatus', p.status)}
              </dd>
              <dt>{t('proposed')}</dt>
              <dd>{fmt.dateTime(p.createdAt)}</dd>
              <dt>{t('theProposal')}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{p.body ?? t('bodyErased')}</dd>
              {p.decidedAt ? (
                <>
                  <dt>{t('answered')}</dt>
                  <dd>
                    {fmt.dateTime(p.decidedAt)}
                    {p.declineReason ? ` · ${label(p.declineReason)}` : ''}
                  </dd>
                </>
              ) : null}
              {p.decisionNote ? (
                <>
                  <dt>{t('boardNote')}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{p.decisionNote}</dd>
                </>
              ) : null}
              {p.withdrawnAt ? (
                <>
                  <dt>{t('withdrawn')}</dt>
                  <dd>{fmt.dateTime(p.withdrawnAt)}</dd>
                </>
              ) : null}
            </dl>
          </Card>
        ) : null}
      </QueryState>
      {deciding && p ? <Decide id={p.id} outcome={deciding} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}
