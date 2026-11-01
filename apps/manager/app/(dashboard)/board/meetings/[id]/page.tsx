'use client';

import { fieldError, formatDate, formatDateTime, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Dialog,
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
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { AGENDA_KIND_TEXT, boardWorkFetchers, boardWorkKeys, MEETING_KIND_TEXT, type MeetingAction } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';

type Seat = { id: string; fullName: string | null; role: string; endedAt: string | null };

/**
 * One board meeting (ADR 0075): its agenda while scheduled; held once with
 * who of the seats sitting was there, or called off; then its minutes (a
 * board publication of kind minutes) and its action items, each with an
 * owner and a due day. The open items of earlier meetings come last, to
 * follow up.
 */
export default function BoardMeetingPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const manager = can('governance.manage');
  const allowed = can('governance.board') || manager;
  const key = boardWorkKeys.meeting(id);
  const q = useQuery({ queryKey: key, queryFn: () => boardWorkFetchers.meeting(id), enabled: allowed });
  // The seats sitting now: the manager's view, or a member's own.
  const seats = useQuery({
    queryKey: ['governance', 'board', 'seats', manager],
    queryFn: async () => {
      const res = manager
        ? await unwrap(api.GET('/api/v1/staff/governance/board'))
        : await unwrap(api.GET('/api/v1/governance/board'));
      return ((res.board?.members ?? []) as Seat[]).filter((s) => !s.endedAt);
    },
    enabled: allowed,
  });
  const [holding, setHolding] = useState(false);
  const [present, setPresent] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [minutesId, setMinutesId] = useState('');
  const [action, setAction] = useState({ title: '', ownerAccountId: '', dueOn: '' });
  const [closing, setClosing] = useState<MeetingAction | null>(null);

  const hold = useAction(
    () => unwrap(api.POST('/api/v1/board/meetings/{id}/hold', { params: { path: { id } }, body: { presentMemberIds: present } })),
    { invalidate: [key], onDone: () => (setHolding(false), toast.show('Recorded as held.')) },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/board/meetings/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    { invalidate: [key], onDone: () => (setCancelling(false), toast.show('Called off. The other sitting members are told.')) },
  );
  const minutes = useAction(
    () =>
      unwrap(api.POST('/api/v1/board/meetings/{id}/minutes', { params: { path: { id } }, body: { publicationId: minutesId.trim() } })),
    { invalidate: [key], onDone: () => toast.show('Minutes linked.') },
  );
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/meetings/{id}/actions', {
          params: { path: { id } },
          body: { title: action.title.trim(), ownerAccountId: action.ownerAccountId, dueOn: action.dueOn },
        }),
      ),
    {
      invalidate: [key],
      onDone: () => (setAction({ title: '', ownerAccountId: '', dueOn: '' }), toast.show('Added. Its owner is told.')),
    },
  );
  const done = useAction(
    (a: MeetingAction) => unwrap(api.POST('/api/v1/board/meeting-actions/{id}/done', { params: { path: { id: a.id } }, body: {} })),
    { invalidate: [key], onDone: () => toast.show('Marked done.') },
  );
  const dropAction = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/board/meeting-actions/{id}/cancel', { params: { path: { id: closing!.id } }, body: { reasonCode } })),
    { invalidate: [key], onDone: () => (setClosing(null), toast.show('Cancelled.')) },
  );

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board meeting" />
        <ForbiddenState />
      </>
    );
  const m = q.data;
  const actionColumns = [
    { key: 't', header: 'Action', cell: (a: MeetingAction) => a.title },
    { key: 'o', header: 'Owner', cell: (a: MeetingAction) => a.ownerName ?? '—' },
    { key: 'd', header: 'Due', cell: (a: MeetingAction) => `${formatDate(a.dueOn)}${a.overdue ? ' · late' : ''}` },
    { key: 's', header: 'Status', cell: (a: MeetingAction) => <StatusBadge status={a.status} /> },
    {
      key: 'x',
      header: '',
      cell: (a: MeetingAction) =>
        a.status === 'open' ? (
          <span className="toolbar">
            <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a)}>
              Done
            </Button>
            <Button size="sm" variant="text" onClick={() => setClosing(a)}>
              Cancel
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={m ? `${m.reference} · ${m.title}` : 'Board meeting'}
        description={m ? `${MEETING_KIND_TEXT[m.kind] ?? m.kind} · ${formatDateTime(m.scheduledAt)}${m.location ? ` · ${m.location}` : ''}` : undefined}
        actions={
          m?.status === 'scheduled' ? (
            <>
              <Button variant="primary" onClick={() => setHolding(true)}>
                Record as held
              </Button>
              <Button variant="text" onClick={() => setCancelling(true)}>
                Call off
              </Button>
            </>
          ) : undefined
        }
      />
      <QueryState query={q}>
        {m ? (
          <>
            <Card>
              <CardHeader title="Status" />
              <p>
                <StatusBadge status={m.status} />{' '}
                {m.status === 'held' ? `${m.present} of ${m.seated} present · ${m.quorate ? 'quorate' : 'no quorum'}` : null}
                {m.cancelReason ? ` · ${m.cancelReason}` : null}
              </p>
            </Card>
            <Card flush>
              <CardHeader title="Agenda" />
              <DataTable
                rows={m.agenda}
                rowKey={(i) => String(i.position)}
                empty="No agenda"
                columns={[
                  { key: 'p', header: '#', cell: (i) => i.position },
                  { key: 'k', header: 'Kind', cell: (i) => AGENDA_KIND_TEXT[i.kind] ?? i.kind },
                  { key: 't', header: 'Item', cell: (i) => i.reference ?? i.title ?? '—' },
                  { key: 's', header: 'Now', cell: (i) => (i.subjectStatus ? <StatusBadge status={i.subjectStatus} /> : '—') },
                ]}
              />
            </Card>
            {m.status === 'held' ? (
              <>
                <Card flush>
                  <CardHeader title="Who was there" />
                  <DataTable
                    rows={m.attendance}
                    rowKey={(a) => a.memberId}
                    columns={[
                      { key: 'n', header: 'Member', cell: (a) => a.fullName ?? '—' },
                      { key: 'r', header: 'Role', cell: (a) => a.role },
                      { key: 'p', header: 'Present', cell: (a) => (a.present ? 'Yes' : 'No') },
                    ]}
                  />
                </Card>
                <Card>
                  <CardHeader title="Minutes" />
                  {m.minutesPublicationId ? (
                    <p>Linked: the board publication {m.minutesPublicationId}.</p>
                  ) : (
                    <div className="stack">
                      <p className="t-secondary">Publish the minutes as a board publication of kind “minutes”, then link it here.</p>
                      <Field label="Publication id" error={fieldError(minutes.error, 'publicationId')}>
                        {(p) => <Input {...p} value={minutesId} onChange={(e) => setMinutesId(e.target.value)} />}
                      </Field>
                      <ErrorAlert error={minutes.error} />
                      <Button loading={minutes.isPending} disabled={!minutesId.trim()} onClick={() => minutes.mutate(undefined)}>
                        Link the minutes
                      </Button>
                    </div>
                  )}
                </Card>
                <Card flush>
                  <CardHeader title="Action items" />
                  <DataTable<MeetingAction> rows={m.actions} rowKey={(a) => a.id} empty="None yet" columns={actionColumns} />
                  <div className="stack">
                    <Field label="Action" error={fieldError(add.error, 'title')}>
                      {(p) => <Input {...p} maxLength={300} value={action.title} onChange={(e) => setAction({ ...action, title: e.target.value })} />}
                    </Field>
                    <Field label="Owner" hint="One of the meeting’s seats" error={fieldError(add.error, 'ownerAccountId')}>
                      {(p) => (
                        <Select {...p} value={action.ownerAccountId} onChange={(e) => setAction({ ...action, ownerAccountId: e.target.value })}>
                          <option value="">Choose…</option>
                          {m.attendance.map((a) => (
                            <option key={a.memberId} value={a.accountId}>
                              {a.fullName ?? a.role}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Due" error={fieldError(add.error, 'dueOn')}>
                      {(p) => <Input {...p} type="date" value={action.dueOn} onChange={(e) => setAction({ ...action, dueOn: e.target.value })} />}
                    </Field>
                    <ErrorAlert error={add.error} />
                    <Button
                      loading={add.isPending}
                      disabled={!action.title.trim() || !action.ownerAccountId || !action.dueOn}
                      onClick={() => add.mutate(undefined)}
                    >
                      Add the action
                    </Button>
                  </div>
                </Card>
              </>
            ) : null}
            <Card flush>
              <CardHeader title="To follow up from earlier meetings" />
              <DataTable<MeetingAction> rows={m.followUp} rowKey={(a) => a.id} empty="Nothing open" columns={actionColumns} />
            </Card>
          </>
        ) : null}
      </QueryState>
      <Dialog
        open={holding}
        onClose={() => setHolding(false)}
        title="Record the meeting as held"
        footer={
          <Button variant="primary" loading={hold.isPending} onClick={() => hold.mutate(undefined)}>
            Record
          </Button>
        }
      >
        <p className="t-secondary">Who of the seats sitting now was present. More than half makes the quorum.</p>
        {(seats.data ?? []).map((s) => (
          <Checkbox
            key={s.id}
            label={`${s.fullName ?? '—'} (${s.role})`}
            checked={present.includes(s.id)}
            onChange={(e) => setPresent((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
          />
        ))}
        <ErrorAlert error={hold.error} />
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Call the meeting off"
        codes={REASON_CODES.boardMeetingCancel}
        confirmLabel="Call off"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title="Cancel the action item"
        codes={REASON_CODES.boardActionCancel}
        confirmLabel="Cancel it"
        danger
        pending={dropAction.isPending}
        error={<ErrorAlert error={dropAction.error} />}
        onConfirm={(code) => dropAction.mutate(code)}
      />
    </>
  );
}
