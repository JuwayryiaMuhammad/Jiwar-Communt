'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { DateRange } from '@/components/date-range';
import { addDays, instantOf, minutesText, personNameIn, postBody, postNameIn, scheduleFrom, scheduleText, today } from '@/components/security/logic';
import { GuardPicker, PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardAttendance, type RosterSlot, type RosterTemplate } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/sec-roster';
import en from '@/messages/en/sec-roster';

const TABS = ['slots', 'templates', 'attendance'] as const;
type Tab = (typeof TABS)[number];
const WEEK = [0, 1, 2, 3, 4, 5, 6] as const;

function SlotDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('slotAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newSlot')}
      description={t('newSlotDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!guardId || !target || !startsAt || !endsAt}>
            {t('addSlot')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('guard')} error={fieldError(save.error, 'guardId')}>
          {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
        </Field>
        <Field label={t('post')} error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <Field label={t('starts')} error={fieldError(save.error, 'startsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
        </Field>
        <Field label={t('ends')} error={fieldError(save.error, 'endsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Slots() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const [range, setRange] = useState({ from: today(), to: addDays(today(), 6) });
  const [guardId, setGuardId] = useState('');
  const [post, setPost] = useState('');
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<RosterSlot | null>(null);
  const filters = { ...range, guardId: guardId || undefined, ...(postBody(post) ?? {}) };
  const slots = useQuery({ queryKey: keys.rosterSlots(filters), queryFn: () => fetchers.rosterSlots(filters) });
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
        toast.show(t('slotCancelled'));
        setCancelling(null);
      },
    },
  );
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
        <Field label={t('guard')}>
          {(p) => <GuardPicker {...p} placeholder={t('allGuards')} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
        </Field>
        <Field label={t('post')}>{(p) => <PostPicker {...p} placeholder={t('allPosts')} value={post} onChange={(e) => setPost(e.target.value)} />}</Field>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('newSlot')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={slots}>
          <DataTable<RosterSlot>
            rows={slots.data?.data}
            rowKey={(s) => s.id}
            empty={t('emptySlots')}
            columns={[
              { key: 'when', header: t('col.when'), cell: (s) => `${f.dateTime(s.startsAt)} – ${f.dateTime(s.endsAt)}` },
              { key: 'guard', header: t('guard'), cell: (s) => personNameIn(s.guard, locale) },
              { key: 'post', header: t('post'), cell: (s) => postNameIn(s.post, locale) },
              {
                key: 'status',
                header: c('status'),
                cell: (s) => (
                  <span className="row">
                    <StatusBadge status={s.status} />
                    {s.shift ? <Badge tone="green">{t('opened')}</Badge> : null}
                    {s.late ? <Badge tone="terracotta">{t('lateBy', { time: minutesText(s.lateMinutes, locale) })}</Badge> : null}
                    {s.absentAt ? <Badge tone="error">{t('absent')}</Badge> : null}
                    {s.swappedAt ? <Badge tone="beige">{t('swapped')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'source', header: t('col.from'), cell: (s) => (s.templateId ? t('fromTemplate') : t('fromSingle')) },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.status === 'scheduled' && !s.shift ? (
                    <Button size="sm" onClick={() => setCancelling(s)}>
                      {c('cancel')}
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
        title={t('cancelSlotTitle')}
        description={t('cancelSlotDescription')}
        codes={REASON_CODES.guardSlotCancel}
        confirmLabel={t('cancelSlot')}
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </div>
  );
}

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
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
        toast.show(t('templateAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newTemplate')}
      description={t('newTemplateDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!guardId || !target || !schedule || !effectiveFrom}>
            {t('addTemplate')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('guard')} error={fieldError(save.error, 'guardId')}>
          {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
        </Field>
        <Field label={t('post')} error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <fieldset className="field">
          <legend className="field__label">{t('weekdays')}</legend>
          <div className="row">
            {WEEK.map((d) => (
              <Checkbox
                key={d}
                label={f.weekday(d, 'short')}
                checked={days.includes(d)}
                onChange={(e) => setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))}
              />
            ))}
          </div>
        </fieldset>
        <div className="row">
          <Field label={c('from')}>{(p) => <Input {...p} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label={c('to')}>{(p) => <Input {...p} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <div className="row">
          <Field label={t('firstDay')} error={fieldError(save.error, 'effectiveFrom')}>
            {(p) => <Input {...p} type="date" min={today()} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}
          </Field>
          <Field label={t('lastDay')} hint={t('lastDayHint')} error={fieldError(save.error, 'effectiveUntil')}>
            {(p) => <Input {...p} type="date" min={effectiveFrom} value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Templates() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
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
        toast.show(t('templateEnded'));
        setEnding(null);
      },
    },
  );
  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented<'live' | 'ended' | ''>
          label={t('templatesShown')}
          value={state}
          onChange={setState}
          options={[
            { value: 'live', label: t('state.live') },
            { value: 'ended', label: t('state.ended') },
            { value: '', label: c('all') },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('newTemplate')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<RosterTemplate>
            rows={list.data?.data}
            rowKey={(x) => x.id}
            empty={t('emptyTemplates')}
            columns={[
              { key: 'guard', header: t('guard'), cell: (x) => personNameIn(x.guard, locale) },
              { key: 'post', header: t('post'), cell: (x) => postNameIn(x.post, locale) },
              { key: 'schedule', header: t('col.everyWeek'), cell: (x) => scheduleText(x.schedule, locale) },
              {
                key: 'days',
                header: t('col.from'),
                cell: (x) => (x.effectiveUntil ? t('periodTo', { from: f.day(x.effectiveFrom), to: f.day(x.effectiveUntil) }) : f.day(x.effectiveFrom)),
              },
              { key: 'state', header: t('col.state'), cell: (x) => <StatusBadge status={x.endedAt ? 'ended' : 'active'} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (x) =>
                  x.endedAt ? null : (
                    <Button size="sm" onClick={() => setEnding(x)}>
                      {t('end')}
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
        title={t('endTitle')}
        description={t('endDescription')}
        footer={
          <>
            <Button onClick={() => setEnding(null)}>{t('keepIt')}</Button>
            <Button variant="primary" loading={end.isPending} onClick={() => end.mutate(undefined)}>
              {t('end')}
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
  const t = useT(en, ar);
  const f = useFormat();
  const { locale } = useLocale();
  const [range, setRange] = useState({ from: addDays(today(), -6), to: today() });
  const report = useQuery({ queryKey: keys.attendance(range), queryFn: () => fetchers.attendance(range) });
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
      </div>
      <p className="t-secondary">{t('attendanceNote')}</p>
      <Card flush>
        <QueryState query={report}>
          <DataTable<GuardAttendance>
            rows={report.data?.data}
            rowKey={(a) => a.guard.id}
            empty={t('emptyAttendance')}
            columns={[
              { key: 'guard', header: t('guard'), cell: (a) => personNameIn(a.guard, locale) },
              {
                key: 'slots',
                header: t('att.slots'),
                cell: (a) => (
                  <span className="t-num">
                    {f.number(a.filled)} / {f.number(a.slots)}
                  </span>
                ),
              },
              { key: 'late', header: t('att.late'), cell: (a) => <span className="t-num">{f.number(a.late)}</span> },
              { key: 'absent', header: t('att.absent'), cell: (a) => <span className="t-num">{f.number(a.absent)}</span> },
              { key: 'scheduled', header: t('att.scheduled'), cell: (a) => minutesText(a.scheduledMinutes, locale) },
              { key: 'worked', header: t('att.worked'), cell: (a) => minutesText(a.workedMinutes, locale) },
              { key: 'overtime', header: t('att.overtime'), cell: (a) => minutesText(a.overtimeMinutes, locale) },
              {
                key: 'unscheduled',
                header: t('att.unscheduled'),
                cell: (a) => `${f.number(a.unscheduledShifts)} · ${minutesText(a.unscheduledMinutes, locale)}`,
              },
            ]}
          />
        </QueryState>
      </Card>
    </div>
  );
}

function RosterView() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'slots');
  if (ready && !can('guard_roster.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label={t('title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'slots', label: t('tab.slots') },
            { value: 'templates', label: t('tab.templates') },
            { value: 'attendance', label: t('tab.attendance') },
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
