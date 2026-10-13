'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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

/**
 * The counts, option by option. While a poll is open they are live, and
 * withheld below five units; once it has closed they are final.
 */
function Results({ poll }: { poll: Poll }) {
  const hidden = hiddenText(poll.resultsHidden);
  const total = poll.options.reduce((sum, o) => sum + (o.votes ?? 0), 0);
  return (
    <Card>
      <SectionHeader
        title={poll.status === 'closed' ? 'Results' : 'Results so far'}
        description="Counts per option. What a unit chose is not kept with the unit, so there is no list of who chose what, for anyone."
      />
      <CardBody>
        <div className="stack">
          {hidden ? <Alert>{hidden}</Alert> : null}
          {poll.options.map((o) => (
            <div key={o.id} className="stack stack--sm">
              <span className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <TwoLanguages en={o.labelEn} ar={o.labelAr} />
                {o.votes === null ? null : (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {o.votes} · {percent(o.votes, total)}%
                  </span>
                )}
              </span>
              {o.votes === null ? null : (
                <progress max={Math.max(total, 1)} value={o.votes} style={{ width: '100%' }} aria-label={`${o.votes} of ${total} votes`} />
              )}
            </div>
          ))}
          {poll.multiple && !hidden ? <span className="t-secondary">A unit may choose several options, so the counts can add up to more than the units that voted.</span> : null}
        </div>
      </CardBody>
    </Card>
  );
}

export default function PollPage() {
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
        toast.show(action === 'close' ? 'The poll is closed. Its results are shown to everyone.' : 'The poll is cancelled. Nothing was counted.');
        setDialog(null);
      },
    },
  );

  if (ready && !allowed) return <ForbiddenState />;
  const p = query.data;
  const actions = p ? pollActions(p.status, p.closedAt !== null) : null;

  return (
    <>
      <PageHeader
        title={p ? (p.questionEn ?? p.questionAr ?? 'Poll') : 'Poll'}
        back={<Back href="/polls" label="Polls" />}
        actions={
          p && actions ? (
            <>
              {actions.edit ? <Button onClick={() => setDialog('edit')}>Edit</Button> : null}
              {actions.reschedule ? <Button onClick={() => setDialog('reschedule')}>Change the closing time</Button> : null}
              {actions.cancel ? (
                <Button variant="danger" onClick={() => setDialog('cancel')}>
                  Cancel the poll
                </Button>
              ) : null}
              {actions.close ? (
                <Button variant="primary" onClick={() => setDialog('close')}>
                  Close now
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
                    {p.multiple ? <Badge plain>Several choices</Badge> : null}
                  </span>
                  <TwoLanguages en={p.questionEn} ar={p.questionAr} strong />
                  <dl className="dl">
                    <dt>Opens</dt>
                    <dd>{formatDateTime(p.opensAt)}</dd>
                    <dt>Closes</dt>
                    <dd>{formatDateTime(p.closedAt ?? p.closesAt)}</dd>
                    <dt>Who votes</dt>
                    <dd>{audienceText(p.audience)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label="Units voted"
                value={p.turnout === null ? (p.resultsHidden === 'few_votes' ? 'Fewer than 5' : '–') : p.turnout}
                hint={
                  p.turnout !== null && audience.data
                    ? `${percent(p.turnout, audience.data.units)}% of the ${audience.data.units} units it is put to now`
                    : audience.data
                      ? `Put to ${audience.data.units} units now`
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
        title="Close this poll now?"
        description="No more votes are taken. The results are final and shown to everyone it was put to, whatever the turnout. The ballots are destroyed: only the counts are kept."
        confirmLabel="Close the poll"
        pending={end.isPending}
        error={end.error ? <ErrorAlert error={end.error} /> : undefined}
        onConfirm={() => end.mutate('close')}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title="Cancel this poll?"
        description="It ends with no result. The ballots are destroyed and nothing is counted. It stays listed as cancelled."
        confirmLabel="Cancel the poll"
        danger
        pending={end.isPending}
        error={end.error ? <ErrorAlert error={end.error} /> : undefined}
        onConfirm={() => end.mutate('cancel')}
      />
    </>
  );
}
