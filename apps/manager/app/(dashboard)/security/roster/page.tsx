'use client';

import { formatDateTime, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { DateRange } from '@/components/date-range';
import {
  addDays,
  instantOf,
  minutesText,
  personName,
  postBody,
  postName,
  scheduleFrom,
  scheduleText,
  today,
  WEEKDAYS,
} from '@/components/security/logic';
import { GuardPicker, PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardAttendance, type RosterSlot, type RosterTemplate } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['slots', 'templates', 'attendance'] as const;
type Tab = (typeof TABS)[number];

function SlotDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [guardId, setGuardId] = useState('');
  const [post, setPost] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const target = postBody(post);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/roster/slots', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { guardId, ...target, startsAt: instantOf(startsAt)!, endsAt: instantOf(endsAt)! },
        }),
      ),
    {
      invalidate: [keys.rosterAll],
      onDone: () => {
        toast.show('Slot added.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="New slot"
      description="One shift of one guard, a day at most. It never overlaps the guard’s other slots or templates."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!guardId || !target || !startsAt || !endsAt}>
            Add slot
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Guard" error={fieldError(save.error, 'guardId')}>
          {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
        </Field>
        <Field label="Post" error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <Field label="Starts" error={fieldError(save.error, 'startsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
        </Field>
        <Field label="Ends" error={fieldError(save.error, 'endsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Slots() {
  const toast = useToast();
  const [range, setRange] = useState({ from: today(), to: addDays(today(), 6) });
  const [guardId, setGuardId] = useState('');
  const [post, setPost] = useState('');
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<RosterSlot | null>(null);
  const f = { ...range, guardId: guardId || undefined, ...(postBody(post) ?? {}) };
  const slots = useQuery({ queryKey: keys.rosterSlots(f), queryFn: () => fetchers.rosterSlots(f) });
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/roster/slots/{id}/cancel', {
          params: { path: { id: cancelling!.id } },
          body: { reasonCode: reasonCode as (typeof REASON_CODES.guardSlotCancel)[number] },
        }),
      ),
    {
      invalidate: [keys.rosterAll],
      onDone: () => {
        toast.show('Slot cancelled.');
        setCancelling(null);
      },
    },
  );
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
        <Field label="Guard">{(p) => <GuardPicker {...p} placeholder="All guards" value={guardId} onChange={(e) => setGuardId(e.target.value)} />}</Field>
        <Field label="Post">{(p) => <PostPicker {...p} placeholder="All posts" value={post} onChange={(e) => setPost(e.target.value)} />}</Field>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          New slot
        </Button>
      </div>
      <Card flush>
        <QueryState query={slots}>
          <DataTable<RosterSlot>
            rows={slots.data?.data}
            rowKey={(s) => s.id}
            empty="No slot in this period"
            columns={[
              { key: 'when', header: 'When', cell: (s) => `${formatDateTime(s.startsAt)} – ${formatDateTime(s.endsAt)}` },
              { key: 'guard', header: 'Guard', cell: (s) => personName(s.guard) },
              { key: 'post', header: 'Post', cell: (s) => postName(s.post) },
              {
                key: 'status',
                header: 'Status',
                cell: (s) => (
                  <span className="row">
                    <StatusBadge status={s.status} />
                    {s.shift ? <Badge tone="green">Opened</Badge> : null}
                    {s.late ? <Badge tone="terracotta">Late {s.lateMinutes} min</Badge> : null}
                    {s.absentAt ? <Badge tone="error">Absent</Badge> : null}
                    {s.swappedAt ? <Badge tone="beige">Swapped</Badge> : null}
                  </span>
                ),
              },
              { key: 'source', header: 'From', cell: (s) => (s.templateId ? 'Template' : 'Single') },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.status === 'scheduled' && !s.shift ? (
                    <Button size="sm" onClick={() => setCancelling(s)}>
                      Cancel
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <SlotDialog onClose={() => setAdding(false)} /> : null}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this slot?"
        description="A swap waiting on it is cancelled too; both guards are told."
        codes={REASON_CODES.guardSlotCancel}
        confirmLabel="Cancel slot"
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </div>
  );
}

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [guardId, setGuardId] = useState('');
  const [post, setPost] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [from, setFrom] = useState('06:00');
  const [to, setTo] = useState('14:00');
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveUntil, setEffectiveUntil] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const target = postBody(post);
  const schedule = scheduleFrom(days, from, to);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/roster/templates', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            guardId,
            ...target,
            schedule: schedule!,
            effectiveFrom,
            ...(effectiveUntil ? { effectiveUntil } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.rosterAll],
      onDone: () => {
        toast.show('Template added: its slots are made 28 days ahead.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New weekly roster"
      description="A guard at a post on the same weekdays every week. A window ending before it starts runs into the next day."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!guardId || !target || !schedule || !effectiveFrom}>
            Add roster
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Guard" error={fieldError(save.error, 'guardId')}>
          {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
        </Field>
        <Field label="Post" error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <fieldset className="field">
          <legend className="field__label">Weekdays</legend>
          <div className="row">
            {WEEKDAYS.map((d, i) => (
              <Checkbox
                key={d}
                label={d}
                checked={days.includes(i)}
                onChange={(e) => setDays(e.target.checked ? [...days, i] : days.filter((x) => x !== i))}
              />
            ))}
          </div>
        </fieldset>
        <div className="row">
          <Field label="From">{(p) => <Input {...p} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <div className="row">
          <Field label="First day" error={fieldError(save.error, 'effectiveFrom')}>
            {(p) => <Input {...p} type="date" min={today()} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}
          </Field>
          <Field label="Last day" hint="Empty: no end." error={fieldError(save.error, 'effectiveUntil')}>
            {(p) => <Input {...p} type="date" min={effectiveFrom} value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Templates() {
  const toast = useToast();
  const [state, setState] = useState<'live' | 'ended' | ''>('live');
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<RosterTemplate | null>(null);
  const list = useQuery({ queryKey: keys.rosterTemplates(state), queryFn: () => fetchers.rosterTemplates(state) });
  const end = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/roster/templates/{id}/end', { params: { path: { id: ending!.id } } })),
    {
      invalidate: [keys.rosterAll],
      onDone: () => {
        toast.show('Ended: its slots to come are cancelled.');
        setEnding(null);
      },
    },
  );
  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented<'live' | 'ended' | ''>
          label="Templates shown"
          value={state}
          onChange={setState}
          options={[
            { value: 'live', label: 'Live' },
            { value: 'ended', label: 'Ended' },
            { value: '', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          New weekly roster
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<RosterTemplate>
            rows={list.data?.data}
            rowKey={(t) => t.id}
            empty="No template"
            columns={[
              { key: 'guard', header: 'Guard', cell: (t) => personName(t.guard) },
              { key: 'post', header: 'Post', cell: (t) => postName(t.post) },
              { key: 'schedule', header: 'Every week', cell: (t) => scheduleText(t.schedule) },
              { key: 'days', header: 'From', cell: (t) => `${t.effectiveFrom}${t.effectiveUntil ? ` to ${t.effectiveUntil}` : ''}` },
              { key: 'state', header: 'State', cell: (t) => <StatusBadge status={t.endedAt ? 'ended' : 'active'} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (t) =>
                  t.endedAt ? null : (
                    <Button size="sm" onClick={() => setEnding(t)}>
                      End
                    </Button>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <TemplateDialog onClose={() => setAdding(false)} /> : null}
      <Dialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title="End this weekly roster?"
        description="Its slots to come that nobody opened and no swap gave away are cancelled."
        footer={
          <>
            <Button onClick={() => setEnding(null)}>Keep it</Button>
            <Button variant="primary" loading={end.isPending} onClick={() => end.mutate(undefined)}>
              End
            </Button>
          </>
        }
      >
        <ErrorAlert error={end.error} />
      </Dialog>
    </div>
  );
}

function Attendance() {
  const [range, setRange] = useState({ from: addDays(today(), -6), to: today() });
  const report = useQuery({ queryKey: keys.attendance(range), queryFn: () => fetchers.attendance(range) });
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
      </div>
      <p className="t-secondary">Recorded only: no payroll. Late is more than ten minutes; absent is not opened an hour after the start (or after the slot was made, if later).</p>
      <Card flush>
        <QueryState query={report}>
          <DataTable<GuardAttendance>
            rows={report.data?.data}
            rowKey={(a) => a.guard.id}
            empty="Nobody was scheduled or on shift"
            columns={[
              { key: 'guard', header: 'Guard', cell: (a) => personName(a.guard) },
              { key: 'slots', header: 'Slots', cell: (a) => <span className="t-num">{a.filled} / {a.slots}</span> },
              { key: 'late', header: 'Late', cell: (a) => <span className="t-num">{a.late}</span> },
              { key: 'absent', header: 'Absent', cell: (a) => <span className="t-num">{a.absent}</span> },
              { key: 'scheduled', header: 'Scheduled', cell: (a) => minutesText(a.scheduledMinutes) },
              { key: 'worked', header: 'Worked', cell: (a) => minutesText(a.workedMinutes) },
              { key: 'overtime', header: 'Overtime', cell: (a) => minutesText(a.overtimeMinutes) },
              { key: 'unscheduled', header: 'Unscheduled', cell: (a) => `${a.unscheduledShifts} · ${minutesText(a.unscheduledMinutes)}` },
            ]}
          />
        </QueryState>
      </Card>
    </div>
  );
}

function RosterView() {
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'slots');
  if (ready && !can('guard_roster.manage'))
    return (
      <>
        <PageHeader title="Guard roster" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Guard roster" description="Who works which gate or zone, when; and how it went." />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label="Roster"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'slots', label: 'Slots' },
            { value: 'templates', label: 'Weekly rosters' },
            { value: 'attendance', label: 'Attendance' },
          ]}
        />
      </div>
      {tab === 'slots' ? <Slots /> : tab === 'templates' ? <Templates /> : <Attendance />}
    </>
  );
}

export default function RosterPage() {
  return (
    <Suspense>
      <RosterView />
    </Suspense>
  );
}
