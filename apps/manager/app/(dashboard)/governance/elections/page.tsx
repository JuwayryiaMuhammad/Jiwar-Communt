'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { inEither, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceElectionPhase, type StaffGovernanceElection } from '@/lib/queries';

type View = GovernanceElectionPhase | 'all';
const iso = (local: string) => new Date(local).toISOString();

function NewElection({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [titleEn, setTitleEn] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [seats, setSeats] = useState(5);
  const [termMonths, setTerm] = useState(24);
  const [nominationsOpenAt, setNomOpen] = useState('');
  const [nominationsCloseAt, setNomClose] = useState('');
  const [votingOpensAt, setVoteOpen] = useState('');
  const [votingClosesAt, setVoteClose] = useState('');
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/governance/elections', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            titleEn: titleEn.trim(),
            bodyEn: bodyEn.trim(),
            seats,
            termMonths,
            ...(nominationsOpenAt ? { nominationsOpenAt: iso(nominationsOpenAt) } : {}),
            nominationsCloseAt: iso(nominationsCloseAt),
            votingOpensAt: iso(votingOpensAt),
            votingClosesAt: iso(votingClosesAt),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Called. The owners are told when nominations open.');
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(create.error, f);
  const ok = titleEn.trim() && bodyEn.trim() && nominationsCloseAt && votingOpensAt && votingClosesAt;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Call an election of the board"
      description="Owners stand while nominations are open; then each unit’s voting owner picks up to as many candidates as there are seats, in secret."
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ok}>
            Call the election
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Title" error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={200} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label="To the owners" error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={3} maxLength={4000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        <div className="row" style={{ gap: 16 }}>
          <Field label="Seats" error={err('seats')}>
            {(p) => <Input {...p} type="number" min={3} max={15} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}
          </Field>
          <Field label="Term (months)" error={err('termMonths')}>
            {(p) => <Input {...p} type="number" min={6} max={60} value={termMonths} onChange={(e) => setTerm(Number(e.target.value))} />}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label="Nominations open (empty: now)" error={err('nominationsOpenAt')}>
            {(p) => <Input {...p} type="datetime-local" value={nominationsOpenAt} onChange={(e) => setNomOpen(e.target.value)} />}
          </Field>
          <Field label="Nominations close" error={err('nominationsCloseAt')}>
            {(p) => <Input {...p} type="datetime-local" value={nominationsCloseAt} onChange={(e) => setNomClose(e.target.value)} />}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label="Voting opens" error={err('votingOpensAt')}>
            {(p) => <Input {...p} type="datetime-local" value={votingOpensAt} onChange={(e) => setVoteOpen(e.target.value)} />}
          </Field>
          <Field label="Voting closes" error={err('votingClosesAt')}>
            {(p) => <Input {...p} type="datetime-local" value={votingClosesAt} onChange={(e) => setVoteClose(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

/** Elections of the board (ADR 0051). */
export default function GovernanceElectionsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [view, setView] = useState<View>('all');
  const [creating, setCreating] = useState(false);
  const phase = view === 'all' ? '' : view;
  const list = useCursorList(keys.governanceElections(phase), (c) => fetchers.governanceElections(phase, c), {
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Elections" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Elections"
        description="Each certified election seats the next board for its term."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New election
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Elections shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All' },
            { value: 'nominating', label: 'Nominations open' },
            { value: 'voting', label: 'Voting' },
            { value: 'closed', label: 'To certify' },
            { value: 'certified', label: 'Certified' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffGovernanceElection>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty="No election"
            columns={[
              {
                key: 'r',
                header: 'Election',
                cell: (e) => (
                  <Link className="table__link" href={`/governance/elections/${e.id}`}>
                    <span className="t-mono">{e.reference}</span> · {inEither(e.titleEn, e.titleAr)}
                  </Link>
                ),
              },
              { key: 's', header: 'Seats', cell: (e) => e.seats },
              { key: 'c', header: 'Candidates', cell: (e) => e.candidates.filter((c) => c.status === 'nominated').length },
              { key: 'v', header: 'Voting', cell: (e) => `${formatDateTime(e.votingOpensAt)} – ${formatDateTime(e.votingClosesAt)}` },
              { key: 't', header: 'Turnout', cell: (e) => turnoutText(e.turnout, e.electorate) },
              { key: 'p', header: 'Phase', cell: (e) => <StatusBadge status={e.phase} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewElection onClose={() => setCreating(false)} /> : null}
    </>
  );
}
