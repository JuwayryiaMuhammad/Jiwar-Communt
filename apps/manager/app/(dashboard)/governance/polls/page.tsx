'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { inEither, RESULT_TEXT, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceContestStatus, type StaffGovernancePoll } from '@/lib/queries';

type View = GovernanceContestStatus | 'all';

function NewPoll({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<'yes_no' | 'choice'>('yes_no');
  const [titleEn, setTitleEn] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [secret, setSecret] = useState(true);
  const [quorumPct, setQuorum] = useState(50);
  const [thresholdPct, setThreshold] = useState(50);
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/governance/polls', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            kind,
            titleEn: titleEn.trim(),
            bodyEn: bodyEn.trim(),
            secret,
            quorumPct,
            thresholdPct,
            ...(kind === 'choice' ? { options: options.map((labelEn) => ({ labelEn: labelEn.trim() })) } : {}),
            ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
            closesAt: new Date(closesAt).toISOString(),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Put to the owners. Their units’ voting owners are told when it opens.');
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(create.error, f);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Put a poll to the owners"
      description="One vote per unit, cast by its voting owner. Its secrecy is fixed once put; nobody sees a count before it closes."
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!titleEn.trim() || !bodyEn.trim() || !closesAt}>
            Put the poll
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Question" error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={200} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label="What it is about" error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={4} maxLength={4000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        <Field label="Answers">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'yes_no' | 'choice')}>
              <option value="yes_no">Yes, no or abstain</option>
              <option value="choice">One of several</option>
            </Select>
          )}
        </Field>
        {kind === 'choice'
          ? options.map((o, i) => (
              <Field key={i} label={`Option ${i + 1}`} error={err(`options.${i}.labelEn`)}>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={200}
                    value={o}
                    onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                )}
              </Field>
            ))
          : null}
        {kind === 'choice' && options.length < 10 ? (
          <Button variant="text" onClick={() => setOptions([...options, ''])}>
            Add an option
          </Button>
        ) : null}
        <Checkbox
          label="Secret ballot (no choice is ever stored with its unit). Unticked: an open vote, each unit’s choice shown to the owners after the close."
          checked={secret}
          onChange={(e) => setSecret(e.target.checked)}
        />
        <div className="row" style={{ gap: 16 }}>
          <Field label="Quorum (% of units)" error={err('quorumPct')}>
            {(p) => <Input {...p} type="number" min={1} max={100} value={quorumPct} onChange={(e) => setQuorum(Number(e.target.value))} />}
          </Field>
          <Field label="To pass (% of votes)" error={err('thresholdPct')}>
            {(p) => (
              <Input {...p} type="number" min={50} max={100} value={thresholdPct} onChange={(e) => setThreshold(Number(e.target.value))} />
            )}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label="Opens (empty: now)" error={err('opensAt')}>
            {(p) => <Input {...p} type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />}
          </Field>
          <Field label="Closes" error={err('closesAt')}>
            {(p) => <Input {...p} type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

/** The owners' polls (ADR 0051): put by the board, or the manager for it. */
export default function GovernancePollsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [view, setView] = useState<View>('open');
  const [creating, setCreating] = useState(false);
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.governancePolls(status), (c) => fetchers.governancePolls(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Owners’ polls" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Owners’ polls"
        description="Binding votes of the owners, one per unit, with a quorum and a pass threshold. The board puts them in the app; the manager may too."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New poll
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Polls shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'closed', label: 'Closed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffGovernancePoll>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No poll"
            columns={[
              {
                key: 'r',
                header: 'Poll',
                cell: (p) => (
                  <Link className="table__link" href={`/governance/polls/${p.id}`}>
                    <span className="t-mono">{p.reference}</span> · {inEither(p.titleEn, p.titleAr)}
                  </Link>
                ),
              },
              { key: 'k', header: 'Ballot', cell: (p) => (p.secret ? 'Secret' : 'Open') },
              { key: 'c', header: 'Closes', cell: (p) => formatDateTime(p.closesAt) },
              { key: 't', header: 'Turnout', cell: (p) => turnoutText(p.turnout, p.electorate) },
              {
                key: 's',
                header: 'Status',
                cell: (p) => <StatusBadge status={p.result ?? p.status} />,
              },
              { key: 'x', header: 'Result', cell: (p) => (p.result ? RESULT_TEXT[p.result] : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewPoll onClose={() => setCreating(false)} /> : null}
    </>
  );
}
