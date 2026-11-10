'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardBody, ConfirmDialog, ForbiddenState, PageHeader, Stat, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back, SectionHeader, TwoLanguages } from '@/components/community/bits';
import { audienceText, hiddenText, percent, pollActions } from '@/components/community/logic';
import { PollDialog } from '@/components/community/poll-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Poll } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-polls';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-polls';

/**
 * The counts, option by option. While a poll is open they are live, and
 * withheld below five units; once it has closed they are final.
 */
function Results({ poll }: { poll: Poll }) {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const hidden = hiddenText(poll.resultsHidden, tc);
  const total = poll.options.reduce((sum, o) => sum + (o.votes ?? 0), 0);
  return (
    <Card>
      <SectionHeader title={poll.status === 'closed' ? t('results') : t('resultsSoFar')} description={t('resultsHint')} />
      <CardBody>
        <div className="stack">
          {hidden ? <Alert>{hidden}</Alert> : null}
          {poll.options.map((o) => (
            <div key={o.id} className="stack stack--sm">
              <span className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <TwoLanguages en={o.labelEn} ar={o.labelAr} />
                {o.votes === null ? null : (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {fmt.number(o.votes)} · {fmt.percent(percent(o.votes, total) / 100, 0)}
                  </span>
                )}
              </span>
              {o.votes === null ? null : (
                <progress
                  max={Math.max(total, 1)}
                  value={o.votes}
                  style={{ width: '100%' }}
                  aria-label={t('votesOf', { votes: o.votes, total })}
                />
              )}
            </div>
          ))}
          {poll.multiple && !hidden ? <span className="t-secondary">{t('multipleHint')}</span> : null}
        </div>
      </CardBody>
    </Card>
  );
}

export default function PollPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.publish');
  const query = useQuery({ queryKey: keys.poll(id), queryFn: () => fetchers.poll(id), enabled: allowed, refetchInterval: 30_000 });
  const audience = useQuery({ queryKey: keys.pollAudience(id), queryFn: () => fetchers.pollAudience(id), enabled: allowed });
  const [dialog, setDialog] = useState<'edit' | 'reschedule' | 'close' | 'cancel' | null>(null);
  const end = useAction(
    (action: 'close' | 'cancel') =>
      action === 'close'
        ? unwrap(api.POST('/api/v1/community/polls/{id}/close', { params: { path: { id } } }))
        : unwrap(api.POST('/api/v1/community/polls/{id}/cancel', { params: { path: { id } } })),
    {
      invalidate: [keys.pollsAll],
      onDone: (_, action) => {
        toast.show(action === 'close' ? t('closedToast') : t('cancelledToast'));
        setDialog(null);
      },
    },
  );

  if (ready && !allowed) return <ForbiddenState />;
  const p = query.data;
  const actions = p ? pollActions(p.status, p.closedAt !== null) : null;
  const heading = p ? ((locale === 'ar' ? (p.questionAr ?? p.questionEn) : (p.questionEn ?? p.questionAr)) ?? t('poll')) : t('poll');

  return (
    <>
      <PageHeader
        title={heading}
        back={<Back href="/polls" label={t('title')} />}
        actions={
          p && actions ? (
            <>
              {actions.edit ? <Button onClick={() => setDialog('edit')}>{t('edit')}</Button> : null}
              {actions.reschedule ? <Button onClick={() => setDialog('reschedule')}>{t('changeClosing')}</Button> : null}
              {actions.cancel ? (
                <Button variant="danger" onClick={() => setDialog('cancel')}>
                  {t('cancelPoll')}
                </Button>
              ) : null}
              {actions.close ? (
                <Button variant="primary" onClick={() => setDialog('close')}>
                  {t('closeNow')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={query}>
        {p ? (
          <div className="stack">
            <Card>
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={p.status} />
                    {p.multiple ? <Badge plain>{t('several')}</Badge> : null}
                  </span>
                  <TwoLanguages en={p.questionEn} ar={p.questionAr} strong />
                  <dl className="dl">
                    <dt>{t('opens')}</dt>
                    <dd>{fmt.dateTime(p.opensAt)}</dd>
                    <dt>{t('closes')}</dt>
                    <dd>{fmt.dateTime(p.closedAt ?? p.closesAt)}</dd>
                    <dt>{t('whoVotes')}</dt>
                    <dd>{audienceText(p.audience, tc, fmt)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label={t('unitsVoted')}
                value={p.turnout === null ? (p.resultsHidden === 'few_votes' ? t('fewerThanFive') : '–') : fmt.number(p.turnout)}
                hint={
                  p.turnout !== null && audience.data
                    ? t('turnoutShare', { share: fmt.percent(percent(p.turnout, audience.data.units) / 100, 0), units: audience.data.units })
                    : audience.data
                      ? t('putTo', { units: audience.data.units })
                      : undefined
                }
              />
            </div>
            <Results poll={p} />
          </div>
        ) : null}
      </QueryState>
      {p && (dialog === 'edit' || dialog === 'reschedule') ? (
        <PollDialog poll={p} closingOnly={dialog === 'reschedule'} open onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />
      ) : null}
      <ConfirmDialog
        open={dialog === 'close'}
        onClose={() => setDialog(null)}
        title={t('closeTitle')}
        description={t('closeDescription')}
        confirmLabel={t('closePoll')}
        pending={end.isPending}
        error={end.error ? <ErrorAlert error={end.error} /> : undefined}
        onConfirm={() => end.mutate('close')}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        confirmLabel={t('cancelPoll')}
        danger
        pending={end.isPending}
        error={end.error ? <ErrorAlert error={end.error} /> : undefined}
        onConfirm={() => end.mutate('cancel')}
      />
    </>
  );
}
