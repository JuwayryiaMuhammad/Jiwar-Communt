'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { appointmentProblems, codeText } from '@/components/governance/logic';
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
import ar from '@/messages/ar/gov-board';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board';
import codesEn from '@/messages/en/gov-codes';

const ROLES: BoardRole[] = ['chair', 'secretary', 'treasurer', 'member'];

/** Owners by name or unit code, for the pickers. */
function OwnerPicker({ onPick, exclude }: { onPick: (o: GovernanceOwner) => void; exclude: readonly string[] }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const [search, setSearch] = useState('');
  const owners = useQuery({ queryKey: keys.owners(search), queryFn: () => fetchers.owners(search) });
  const rows = (owners.data?.data ?? []).filter((o) => !exclude.includes(o.accountId));
  return (
    <div className="stack">
      <Field label={t('findOwner')}>
        {(p) => <Input {...p} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('findPlaceholder')} />}
      </Field>
      <DataTable<GovernanceOwner>
        rows={rows.slice(0, 8)}
        rowKey={(o) => o.accountId}
        empty={owners.isLoading ? t('looking') : t('noOwner')}
        columns={[
          { key: 'n', header: t('col.owner'), cell: (o) => o.fullName ?? '—' },
          { key: 'u', header: t('col.units'), cell: (o) => <span className="t-mono ltr">{f.list(o.unitCodes)}</span> },
          {
            key: 'a',
            header: '',
            cell: (o) => (
              <Button variant="text" onClick={() => onPick(o)}>
                {c('add')}
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

function Appoint({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [seats, setSeats] = useState(5);
  const [endsOn, setEndsOn] = useState('');
  const [members, setMembers] = useState<{ owner: GovernanceOwner; role: BoardRole }[]>([]);
  const problems = appointmentProblems(
    g,
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
        toast.show(t('appointedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('appointTitle')}
      description={t('appointDescription')}
      onSubmit={() => appoint.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={appoint.isPending} disabled={problems.length > 0 || !endsOn}>
            {t('appoint')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('seats')}>
            {(p) => <Input {...p} type="number" min={3} max={15} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}
          </Field>
          <Field label={t('termEnds')}>
            {(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
          </Field>
        </div>
        <DataTable<{ owner: GovernanceOwner; role: BoardRole }>
          rows={members}
          rowKey={(m) => m.owner.accountId}
          empty={t('addThree')}
          columns={[
            { key: 'n', header: t('col.member'), cell: (m) => m.owner.fullName ?? '—' },
            {
              key: 'r',
              header: t('col.role'),
              cell: (m) => (
                <Select
                  aria-label={t('col.role')}
                  value={m.role}
                  onChange={(e) =>
                    setMembers(members.map((x) => (x === m ? { ...x, role: e.target.value as BoardRole } : x)))
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {codeText(g, 'role', r)}
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
                  {c('remove')}
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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
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
        toast.show(t('seatedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('fillTitle')}
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!owner}>
            {owner?.fullName ? t('seatName', { name: owner.fullName }) : t('seat')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('col.role')}>
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as BoardRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {codeText(g, 'role', r)}
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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const board = useQuery({ queryKey: keys.board, queryFn: fetchers.board, enabled: allowed });
  const terms = useCursorList(keys.boardTerms, (cursor) => fetchers.boardTerms(cursor), { enabled: allowed });
  const [appointing, setAppointing] = useState(false);
  const [filling, setFilling] = useState(false);
  const [ending, setEnding] = useState<StaffBoardSeat | null>(null);
  const role = useAction(
    (v: { id: string; role: BoardRole }) =>
      unwrap(api.PATCH('/api/v1/staff/governance/board/members/{id}', { params: { path: { id: v.id } }, body: { role: v.role } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show(t('roleRecorded')) },
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
        toast.show(t('seatEnded'));
        setEnding(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const b = board.data?.board ?? null;
  const seated = b ? b.members.filter((m) => !m.endedAt) : [];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          b?.status === 'current' ? (
            seated.length < b.seats ? (
              <Button variant="primary" onClick={() => setFilling(true)}>
                {t('fillSeat')}
              </Button>
            ) : null
          ) : (
            <Button variant="primary" onClick={() => setAppointing(true)}>
              {t('appointBoard')}
            </Button>
          )
        }
      />
      <QueryState query={board}>
        {b ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={b.status} />
                </dd>
                <dt>{t('term')}</dt>
                <dd>{t('termLine', { from: f.date(b.startsAt), to: f.date(b.endsAt), how: b.source === 'elected' ? 'elected' : 'appointed' })}</dd>
                <dt>{t('seats')}</dt>
                <dd>{t('seatsFilled', { n: seated.length, seats: b.seats })}</dd>
              </dl>
            </Card>
            <Card flush>
              <CardHeader title={t('members')} />
              <DataTable<StaffBoardSeat>
                rows={b.members}
                rowKey={(m) => m.id}
                empty={t('nobody')}
                columns={[
                  { key: 'n', header: t('col.member'), cell: (m) => m.fullName ?? <span className="t-secondary">{t('erased')}</span> },
                  {
                    key: 'r',
                    header: t('col.role'),
                    cell: (m) =>
                      m.endedAt || b.status !== 'current' ? (
                        codeText(g, 'role', m.role)
                      ) : (
                        <Select
                          aria-label={t('col.role')}
                          value={m.role}
                          disabled={role.isPending}
                          onChange={(e) => role.mutate({ id: m.id, role: e.target.value as BoardRole })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {codeText(g, 'role', r)}
                            </option>
                          ))}
                        </Select>
                      ),
                  },
                  { key: 's', header: t('col.since'), cell: (m) => f.date(m.addedAt) },
                  {
                    key: 'e',
                    header: t('col.ended'),
                    cell: (m) => (m.endedAt ? `${f.dateTime(m.endedAt)} · ${m.endReason ? label(m.endReason) : ''}` : '—'),
                  },
                  {
                    key: 'a',
                    header: '',
                    cell: (m) =>
                      !m.endedAt && b.status === 'current' ? (
                        <Button variant="text" onClick={() => setEnding(m)}>
                          {t('endSeat')}
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <ErrorAlert error={role.error} />
            </Card>
          </div>
        ) : (
          <EmptyState title={t('noBoard')}>{t('noBoardBody')}</EmptyState>
        )}
      </QueryState>
      <Card flush>
        <CardHeader title={t('terms')} />
        <QueryState query={terms}>
          <DataTable<StaffBoardTerm>
            rows={terms.rows}
            rowKey={(m) => m.id}
            empty={t('noTerm')}
            columns={[
              { key: 'd', header: t('term'), cell: (m) => `${f.date(m.startsAt)} – ${f.date(m.endedAt ?? m.endsAt)}` },
              { key: 'o', header: t('col.how'), cell: (m) => (m.source === 'elected' ? t('how.elected') : t('how.appointed')) },
              { key: 'm', header: t('members'), cell: (m) => f.list(m.members.map((x) => x.fullName ?? '—')) },
              { key: 's', header: c('status'), cell: (m) => <StatusBadge status={m.status} /> },
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
        title={ending?.fullName ? t('endTitleNamed', { name: ending.fullName }) : t('endTitleThis')}
        codes={REASON_CODES.boardMemberEnd}
        confirmLabel={t('endSeat')}
        danger
        pending={end.isPending}
        error={<ErrorAlert error={end.error} />}
        onConfirm={(reasonCode) => ending && end.mutate({ id: ending.id, reasonCode })}
      />
    </>
  );
}
