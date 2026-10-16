'use client';

import { formatDate, formatDateTime, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { appointmentProblems, ROLE_TEXT } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type BoardRole,
  type GovernanceOwner,
  type StaffBoardSeat,
  type StaffBoardTerm,
} from '@/lib/queries';

const ROLES: BoardRole[] = ['chair', 'secretary', 'treasurer', 'member'];

/** Owners by name or unit code, for the pickers. */
function OwnerPicker({ onPick, exclude }: { onPick: (o: GovernanceOwner) => void; exclude: readonly string[] }) {
  const [search, setSearch] = useState('');
  const owners = useQuery({ queryKey: keys.owners(search), queryFn: () => fetchers.owners(search) });
  const rows = (owners.data?.data ?? []).filter((o) => !exclude.includes(o.accountId));
  return (
    <div className="stack">
      <Field label="Find an owner by name or unit">
        {(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. B-12" />}
      </Field>
      <DataTable<GovernanceOwner>
        rows={rows.slice(0, 8)}
        rowKey={(o) => o.accountId}
        empty={owners.isLoading ? 'Looking…' : 'No owner found'}
        columns={[
          { key: 'n', header: 'Owner', cell: (o) => o.fullName ?? '—' },
          { key: 'u', header: 'Units', cell: (o) => <span className="t-mono">{o.unitCodes.join(', ')}</span> },
          {
            key: 'a',
            header: '',
            cell: (o) => (
              <Button variant="text" onClick={() => onPick(o)}>
                Add
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

function Appoint({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [seats, setSeats] = useState(5);
  const [endsOn, setEndsOn] = useState('');
  const [members, setMembers] = useState<{ owner: GovernanceOwner; role: BoardRole }[]>([]);
  const problems = appointmentProblems(
    seats,
    members.map((m) => ({ accountId: m.owner.accountId, role: m.role })),
  );
  const appoint = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/board/appoint', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            seats,
            endsAt: new Date(`${endsOn}T23:59:59`).toISOString(),
            members: members.map((m) => ({ accountId: m.owner.accountId, role: m.role })),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('The board sits. Its members were told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Appoint the board"
      description="Only when no board sits: the first one, or after a term lapsed. Later boards come from elections."
      onSubmit={() => appoint.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={appoint.isPending} disabled={problems.length > 0 || !endsOn}>
            Appoint
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label="Seats">
            {(p) => <Input {...p} type="number" min={3} max={15} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}
          </Field>
          <Field label="The term ends on">
            {(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
          </Field>
        </div>
        <DataTable<{ owner: GovernanceOwner; role: BoardRole }>
          rows={members}
          rowKey={(m) => m.owner.accountId}
          empty="Add 3 owners at least"
          columns={[
            { key: 'n', header: 'Member', cell: (m) => m.owner.fullName ?? '—' },
            {
              key: 'r',
              header: 'Role',
              cell: (m) => (
                <Select
                  aria-label="Role"
                  value={m.role}
                  onChange={(e) =>
                    setMembers(members.map((x) => (x === m ? { ...x, role: e.target.value as BoardRole } : x)))
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_TEXT[r]}
                    </option>
                  ))}
                </Select>
              ),
            },
            {
              key: 'x',
              header: '',
              cell: (m) => (
                <Button variant="text" onClick={() => setMembers(members.filter((x) => x !== m))}>
                  Remove
                </Button>
              ),
            },
          ]}
        />
        <OwnerPicker
          exclude={members.map((m) => m.owner.accountId)}
          onPick={(owner) => setMembers([...members, { owner, role: members.length ? 'member' : 'chair' }])}
        />
        {problems.map((p) => (
          <p key={p} className="t-secondary">
            {p}
          </p>
        ))}
        <ErrorAlert error={appoint.error} />
      </div>
    </Dialog>
  );
}

function FillSeat({ board, onClose }: { board: StaffBoardTerm; onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [owner, setOwner] = useState<GovernanceOwner | null>(null);
  const [role, setRole] = useState<BoardRole>('member');
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/board/members', {
          params: { header: { 'Idempotency-Key': key } },
          body: { accountId: owner!.accountId, role },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Seated. They were told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Fill a vacant seat"
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!owner}>
            Seat {owner?.fullName ?? ''}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Role">
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as BoardRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_TEXT[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <OwnerPicker
          exclude={board.members.filter((m) => !m.endedAt).map((m) => m.accountId)}
          onPick={setOwner}
        />
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

/** The owners' board (ADR 0051): the term open now, its seats, its history. */
export default function BoardPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const board = useQuery({ queryKey: keys.board, queryFn: fetchers.board, enabled: allowed });
  const terms = useCursorList(keys.boardTerms, (c) => fetchers.boardTerms(c), { enabled: allowed });
  const [appointing, setAppointing] = useState(false);
  const [filling, setFilling] = useState(false);
  const [ending, setEnding] = useState<StaffBoardSeat | null>(null);
  const role = useAction(
    (v: { id: string; role: BoardRole }) =>
      unwrap(api.PATCH('/api/v1/staff/governance/board/members/{id}', { params: { path: { id: v.id } }, body: { role: v.role } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show('Role recorded.') },
  );
  const end = useAction(
    (v: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/governance/board/members/{id}/end', {
          params: { path: { id: v.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('The seat ended. It holds nothing of the board from now on.');
        setEnding(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board" />
        <ForbiddenState />
      </>
    );
  const b = board.data?.board ?? null;
  const seated = b ? b.members.filter((m) => !m.endedAt) : [];
  return (
    <>
      <PageHeader
        title="Board"
        description="The owners’ board: its members and offices. The manager appoints a board when none sits; elections seat the next ones."
        actions={
          b?.status === 'current' ? (
            seated.length < b.seats ? (
              <Button variant="primary" onClick={() => setFilling(true)}>
                Fill a seat
              </Button>
            ) : null
          ) : (
            <Button variant="primary" onClick={() => setAppointing(true)}>
              Appoint a board
            </Button>
          )
        }
      />
      <QueryState query={board}>
        {b ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={b.status} />
                </dd>
                <dt>Term</dt>
                <dd>
                  {formatDate(b.startsAt)} – {formatDate(b.endsAt)} · {b.source === 'elected' ? 'elected' : 'appointed'}
                </dd>
                <dt>Seats</dt>
                <dd>
                  {seated.length} of {b.seats} filled
                </dd>
              </dl>
            </Card>
            <Card flush>
              <CardHeader title="Members" />
              <DataTable<StaffBoardSeat>
                rows={b.members}
                rowKey={(m) => m.id}
                empty="Nobody sits"
                columns={[
                  { key: 'n', header: 'Member', cell: (m) => m.fullName ?? <span className="t-secondary">Erased</span> },
                  {
                    key: 'r',
                    header: 'Role',
                    cell: (m) =>
                      m.endedAt || b.status !== 'current' ? (
                        ROLE_TEXT[m.role]
                      ) : (
                        <Select
                          aria-label="Role"
                          value={m.role}
                          disabled={role.isPending}
                          onChange={(e) => role.mutate({ id: m.id, role: e.target.value as BoardRole })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_TEXT[r]}
                            </option>
                          ))}
                        </Select>
                      ),
                  },
                  { key: 's', header: 'Since', cell: (m) => formatDate(m.addedAt) },
                  {
                    key: 'e',
                    header: 'Ended',
                    cell: (m) => (m.endedAt ? `${formatDateTime(m.endedAt)} · ${m.endReason ?? ''}` : '—'),
                  },
                  {
                    key: 'a',
                    header: '',
                    cell: (m) =>
                      !m.endedAt && b.status === 'current' ? (
                        <Button variant="text" onClick={() => setEnding(m)}>
                          End seat
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <ErrorAlert error={role.error} />
            </Card>
          </div>
        ) : (
          <EmptyState title="No board yet">Appoint the first board of the owners.</EmptyState>
        )}
      </QueryState>
      <Card flush>
        <CardHeader title="Terms" />
        <QueryState query={terms}>
          <DataTable<StaffBoardTerm>
            rows={terms.rows}
            rowKey={(t) => t.id}
            empty="No term yet"
            columns={[
              { key: 'd', header: 'Term', cell: (t) => `${formatDate(t.startsAt)} – ${formatDate(t.endedAt ?? t.endsAt)}` },
              { key: 'o', header: 'How', cell: (t) => (t.source === 'elected' ? 'Elected' : 'Appointed') },
              { key: 'm', header: 'Members', cell: (t) => t.members.map((m) => m.fullName ?? '—').join(', ') },
              { key: 's', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
            ]}
          />
          <LoadMore query={terms} />
        </QueryState>
      </Card>
      {appointing ? <Appoint onClose={() => setAppointing(false)} /> : null}
      {filling && b ? <FillSeat board={b} onClose={() => setFilling(false)} /> : null}
      <ReasonCodeDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={`End ${ending?.fullName ?? 'this'}’s seat?`}
        codes={REASON_CODES.boardMemberEnd}
        confirmLabel="End seat"
        danger
        pending={end.isPending}
        error={<ErrorAlert error={end.error} />}
        onConfirm={(reasonCode) => ending && end.mutate({ id: ending.id, reasonCode })}
      />
    </>
  );
}
