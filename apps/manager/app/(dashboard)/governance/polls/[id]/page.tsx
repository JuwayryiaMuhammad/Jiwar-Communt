'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { inEither, optionText, RESULT_TEXT, share, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffGovernancePoll } from '@/lib/queries';

type Option = StaffGovernancePoll['options'][number];
type RollCall = NonNullable<StaffGovernancePoll['rollCall']>[number];

/** One poll of the owners (ADR 0051): its question, turnout and result. */
export default function GovernancePollPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const poll = useQuery({ queryKey: keys.governancePoll(id), queryFn: () => fetchers.governancePoll(id), enabled: allowed });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/governance/polls/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Cancelled. Nothing was counted.');
        setCancelling(false);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/governance/polls" label="Owners’ polls" />} title="Poll" />
        <ForbiddenState />
      </>
    );
  const p = poll.data;
  const total = p ? p.options.reduce((n, o) => n + (o.votes ?? 0), 0) : 0;
  const label = (optionId: string) => {
    const o = p?.options.find((x) => x.id === optionId);
    return o ? optionText(o) : '—';
  };
  return (
    <>
      <PageHeader
        back={<Back href="/governance/polls" label="Owners’ polls" />}
        title={p ? `${p.reference} · ${inEither(p.titleEn, p.titleAr)}` : 'Poll'}
        description={p ? `${p.secret ? 'Secret ballot' : 'Open vote'} · ${formatDateTime(p.opensAt)} – ${formatDateTime(p.closesAt)}` : undefined}
        actions={
          p && (p.status === 'scheduled' || p.status === 'open') ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Cancel the poll
            </Button>
          ) : null
        }
      />
      <QueryState query={poll}>
        {p ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={p.status} />
                  {p.cancelReasonCode ? ` · ${humanize(p.cancelReasonCode)}` : ''}
                </dd>
                <dt>About</dt>
                <dd>{inEither(p.bodyEn, p.bodyAr)}</dd>
                <dt>Turnout</dt>
                <dd>{turnoutText(p.turnout, p.electorate)}</dd>
                <dt>Quorum</dt>
                <dd>{p.quorumPct} % of the units</dd>
                <dt>To pass</dt>
                <dd>
                  {p.thresholdPct} % of the votes{p.kind === 'yes_no' ? ' (yes and no; abstentions left out)' : ''}
                </dd>
                <dt>Put by</dt>
                <dd>{p.authorSide === 'board' ? 'The board' : 'The management'}</dd>
                {p.result ? (
                  <>
                    <dt>Result</dt>
                    <dd>
                      <StatusBadge status={p.result} /> {RESULT_TEXT[p.result]}
                      {p.winningOptionId ? ` · ${label(p.winningOptionId)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title="Answers">
                {p.status === 'closed' ? null : (
                  <span className="t-secondary">Counts show once the poll closes: nobody sees one before, the management included.</span>
                )}
              </CardHeader>
              <DataTable<Option>
                rows={p.options}
                rowKey={(o) => o.id}
                columns={[
                  { key: 'o', header: 'Answer', cell: (o) => optionText(o) },
                  { key: 'v', header: 'Votes', cell: (o) => (o.votes === null ? '—' : o.votes) },
                  { key: 's', header: 'Share', cell: (o) => (o.votes === null ? '—' : share(o.votes, total)) },
                ]}
              />
            </Card>
            {p.rollCall ? (
              <Card flush>
                <CardHeader title="Roll call">
                  <span className="t-secondary">An open vote: each unit’s answer, as the owners see it.</span>
                </CardHeader>
                <DataTable<RollCall>
                  rows={p.rollCall}
                  rowKey={(r) => r.unitCode}
                  empty="No unit voted"
                  columns={[
                    { key: 'u', header: 'Unit', cell: (r) => <span className="t-mono">{r.unitCode}</span> },
                    { key: 'c', header: 'Answer', cell: (r) => r.choice.map(label).join(', ') },
                  ]}
                />
              </Card>
            ) : null}
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel the poll?"
        description="It ends with no result; a secret poll’s ballots are destroyed unread."
        codes={REASON_CODES.governancePollCancel}
        confirmLabel="Cancel the poll"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
    </>
  );
}
