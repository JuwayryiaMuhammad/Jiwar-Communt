'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Translate } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  Textarea,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ZoneSelect } from '@/components/field-team/zone-select';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/ops-field-team';
import en from '@/messages/en/ops-field-team';
import { CertificatesTab, LocationTab, ReinforcementTab } from './part-b';

interface Ref {
  id: string;
  fullName?: string | null;
}
interface DutySlot {
  id: string;
  technician: Ref;
  zone: { nameEn: string; nameAr: string } | null;
  startsAt: string;
  endsAt: string;
  status: string;
  dutyStartedAt: string | null;
  dutyEndedAt: string | null;
  late: boolean;
  overtimeMinutes: number | null;
  absentAt: string | null;
}
interface Attendance {
  technician: Ref;
  slots: number;
  filled: number;
  late: number;
  absent: number;
  scheduledMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
}
interface Instruction {
  id: string;
  title: string;
  urgent: boolean;
  recipients: number;
  acknowledged: number;
  createdAt: string;
  archivedAt: string | null;
}
interface Help {
  id: string;
  kind: string;
  status: string;
  requester: Ref;
  ticket: { number: string } | null;
  note: string | null;
  helper: Ref | null;
  escalatedAt: string | null;
  createdAt: string;
}

const TABS = ['help', 'roster', 'attendance', 'instructions', 'reinforcement', 'certificates', 'location'] as const;
type Tab = (typeof TABS)[number];
const name = (t: Translate<typeof en>, r: Ref | null) => (r ? (r.fullName ?? t('erased')) : '—');
const list = <T,>(res: unknown) => (res as { data: T[] }).data;

/**
 * The field team (ADR 0078): calls for help to take, the technicians'
 * roster and attendance (the guards' roster, the maintenance crew), and
 * the instructions every technician acknowledges.
 */
export default function FieldTeamPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('help');
  // A notice or the inbox opens a tab by its name (ADR 0090).
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    if (asked && (TABS as readonly string[]).includes(asked)) setTab(asked as Tab);
  }, []);
  const allowed = can('field_team.manage');
  const help = useQuery({
    queryKey: ['field-team', 'help'],
    queryFn: async () => list<Help>(await unwrap(api.GET('/api/v1/staff/field-team/help-requests', {}))),
    enabled: allowed && tab === 'help',
  });
  const technicians = useQuery({
    queryKey: ['field-team', 'technicians'],
    queryFn: async () => list<Ref>(await unwrap(api.GET('/api/v1/staff/field-team/technicians', {}))),
    enabled: allowed,
  });
  const slots = useQuery({
    queryKey: ['field-team', 'slots'],
    queryFn: async () => list<DutySlot>(await unwrap(api.GET('/api/v1/staff/field-team/roster/slots', {}))),
    enabled: allowed && tab === 'roster',
  });
  const attendance = useQuery({
    queryKey: ['field-team', 'attendance'],
    queryFn: async () => list<Attendance>(await unwrap(api.GET('/api/v1/staff/field-team/attendance', {}))),
    enabled: allowed && tab === 'attendance',
  });
  const instructions = useQuery({
    queryKey: ['field-team', 'instructions'],
    queryFn: async () => list<Instruction>(await unwrap(api.GET('/api/v1/staff/field-team/instructions', {}))),
    enabled: allowed && tab === 'instructions',
  });
  const [helper, setHelper] = useState<Record<string, string>>({});
  const take = useAction(
    ({ id, helperId }: { id: string; helperId?: string }) =>
      unwrap(
        api.POST('/api/v1/staff/field-team/help-requests/{id}/take', {
          params: { path: { id } },
          body: helperId ? { helperId } : {},
        }),
      ),
    { invalidate: [['field-team']], onDone: () => toast.show(t('taken')) },
  );
  const resolve = useAction(
    (id: string) =>
      unwrap(api.POST('/api/v1/staff/field-team/help-requests/{id}/resolve', { params: { path: { id } } })),
    { invalidate: [['field-team']], onDone: () => toast.show(t('resolvedToast')) },
  );
  const [slot, setSlot] = useState({ technicianId: '', zoneId: '', startsAt: '', hours: '8' });
  const addSlot = useAction(
    () => {
      const startsAt = new Date(slot.startsAt);
      return unwrap(
        api.POST('/api/v1/staff/field-team/roster/slots', {
          body: {
            technicianId: slot.technicianId,
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + Number(slot.hours) * 3_600_000).toISOString(),
            ...(slot.zoneId ? { zoneId: slot.zoneId } : {}),
          },
        }),
      );
    },
    { invalidate: [['field-team']], onDone: () => toast.show(t('slotAdded')) },
  );
  const [words, setWords] = useState({ title: '', body: '', urgent: false });
  const send = useAction(
    () => unwrap(api.POST('/api/v1/staff/field-team/instructions', { body: words })),
    {
      invalidate: [['field-team']],
      onDone: () => {
        toast.show(t('sent'));
        setWords({ title: '', body: '', urgent: false });
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
  const zone = (z: DutySlot['zone']) => (z ? (locale === 'ar' ? z.nameAr : z.nameEn) : t('wholeCompound'));
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="row" role="group" aria-label={t('tabs')} style={{ gap: 8, marginBottom: 12 }}>
        {TABS.map((x) => (
          <Button key={x} size="sm" variant={x === tab ? 'primary' : undefined} onClick={() => setTab(x)}>
            {t(`tab.${x}`)}
          </Button>
        ))}
      </div>

      {tab === 'help' ? (
        <Card flush>
          <ErrorAlert error={take.error ?? resolve.error} />
          <QueryState query={help}>
            <DataTable<Help>
              rows={help.data ?? []}
              rowKey={(r) => r.id}
              empty={t('noHelp')}
              columns={[
                { key: 'w', header: t('col.when'), cell: (r) => fmt.dateTime(r.createdAt) },
                { key: 'k', header: t('col.kind'), cell: (r) => label(r.kind) },
                { key: 'r', header: t('col.technician'), cell: (r) => name(t, r.requester) },
                { key: 't', header: t('col.ticket'), cell: (r) => r.ticket?.number ?? '—' },
                { key: 'n', header: t('col.note'), cell: (r) => r.note ?? '' },
                {
                  key: 's',
                  header: t('col.status'),
                  cell: (r) => (r.escalatedAt ? t('escalated', { status: label(r.status) }) : label(r.status)),
                },
                { key: 'h', header: t('col.helper'), cell: (r) => name(t, r.helper) },
                {
                  key: 'x',
                  header: <span className="visually-hidden">{t('actions')}</span>,
                  className: 'table__actions',
                  cell: (r) =>
                    r.status === 'open' ? (
                      <span className="row" style={{ gap: 6 }}>
                        <Select
                          aria-label={t('sendTechnician')}
                          value={helper[r.id] ?? ''}
                          onChange={(e) => setHelper({ ...helper, [r.id]: e.target.value })}
                        >
                          <option value="">{t('noOneSent')}</option>
                          {(technicians.data ?? [])
                            .filter((x) => x.id !== r.requester.id)
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.fullName}
                              </option>
                            ))}
                        </Select>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={take.isPending}
                          onClick={() => take.mutate({ id: r.id, helperId: helper[r.id] || undefined })}
                        >
                          {t('take')}
                        </Button>
                      </span>
                    ) : r.status === 'taken' ? (
                      <Button size="sm" loading={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
                        {t('resolve')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
      ) : null}

      {tab === 'roster' ? (
        <>
          <Card>
            <CardHeader title={t('addSlot')} />
            <CardBody>
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label={t('technician')}>
                  {(p) => (
                    <Select {...p} value={slot.technicianId} onChange={(e) => setSlot({ ...slot, technicianId: e.target.value })}>
                      <option value="">{t('choose')}</option>
                      {(technicians.data ?? []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.fullName}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('zone')}>
                  {(p) => <ZoneSelect {...p} value={slot.zoneId} onChange={(e) => setSlot({ ...slot, zoneId: e.target.value })} />}
                </Field>
                <Field label={t('starts')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="datetime-local"
                      value={slot.startsAt}
                      onChange={(e) => setSlot({ ...slot, startsAt: e.target.value })}
                    />
                  )}
                </Field>
                <Field label={t('hours')}>
                  {(p) => (
                    <Input {...p} type="number" min={1} max={24} value={slot.hours} onChange={(e) => setSlot({ ...slot, hours: e.target.value })} />
                  )}
                </Field>
                <Button
                  variant="primary"
                  disabled={!slot.technicianId || !slot.startsAt}
                  loading={addSlot.isPending}
                  onClick={() => addSlot.mutate()}
                >
                  {t('add')}
                </Button>
              </div>
              <ErrorAlert error={addSlot.error} />
            </CardBody>
          </Card>
          <Card flush>
            <QueryState query={slots}>
              <DataTable<DutySlot>
                rows={slots.data ?? []}
                rowKey={(r) => r.id}
                empty={t('noSlot')}
                columns={[
                  { key: 't', header: t('col.technician'), cell: (r) => name(t, r.technician) },
                  { key: 'z', header: t('col.zone'), cell: (r) => zone(r.zone) },
                  { key: 's', header: t('col.starts'), cell: (r) => fmt.dateTime(r.startsAt) },
                  { key: 'e', header: t('col.ends'), cell: (r) => fmt.dateTime(r.endsAt) },
                  {
                    key: 'd',
                    header: t('col.onDuty'),
                    cell: (r) =>
                      r.status === 'cancelled'
                        ? t('cancelled')
                        : r.dutyStartedAt
                          ? r.late
                            ? t('late', { when: fmt.dateTime(r.dutyStartedAt) })
                            : fmt.dateTime(r.dutyStartedAt)
                          : r.absentAt
                            ? t('absent')
                            : '—',
                  },
                  {
                    key: 'o',
                    header: t('col.overtime'),
                    cell: (r) => (r.overtimeMinutes ? t('minutes', { n: fmt.number(r.overtimeMinutes) }) : ''),
                  },
                ]}
              />
            </QueryState>
          </Card>
        </>
      ) : null}

      {tab === 'attendance' ? (
        <Card flush>
          <QueryState query={attendance}>
            <DataTable<Attendance>
              rows={attendance.data ?? []}
              rowKey={(r) => r.technician.id}
              empty={t('noSlotPeriod')}
              columns={[
                { key: 't', header: t('col.technician'), cell: (r) => name(t, r.technician) },
                { key: 's', header: t('col.slots'), cell: (r) => fmt.number(r.slots) },
                { key: 'f', header: t('col.onDuty'), cell: (r) => fmt.number(r.filled) },
                { key: 'l', header: t('col.late'), cell: (r) => fmt.number(r.late) },
                { key: 'a', header: t('col.absent'), cell: (r) => fmt.number(r.absent) },
                { key: 'w', header: t('col.worked'), cell: (r) => fmt.number(r.workedMinutes) },
                { key: 'o', header: t('col.overtimeMin'), cell: (r) => fmt.number(r.overtimeMinutes) },
              ]}
            />
          </QueryState>
        </Card>
      ) : null}

      {tab === 'reinforcement' ? <ReinforcementTab /> : null}
      {tab === 'certificates' ? <CertificatesTab technicians={technicians.data ?? []} /> : null}
      {tab === 'location' ? <LocationTab technicians={technicians.data ?? []} /> : null}

      {tab === 'instructions' ? (
        <>
          <Card>
            <CardHeader title={t('sendInstruction')} />
            <CardBody>
              <Field label={t('instructionTitle')}>
                {(p) => <Input {...p} maxLength={120} value={words.title} onChange={(e) => setWords({ ...words, title: e.target.value })} />}
              </Field>
              <Field label={t('instruction')}>
                {(p) => (
                  <Textarea {...p} maxLength={4000} rows={4} value={words.body} onChange={(e) => setWords({ ...words, body: e.target.value })} />
                )}
              </Field>
              <Checkbox label={t('urgent')} checked={words.urgent} onChange={(e) => setWords({ ...words, urgent: e.target.checked })} />
              <ErrorAlert error={send.error} />
              <Button variant="primary" disabled={!words.title || !words.body} loading={send.isPending} onClick={() => send.mutate()}>
                {t('send')}
              </Button>
            </CardBody>
          </Card>
          <Card flush>
            <QueryState query={instructions}>
              <DataTable<Instruction>
                rows={instructions.data ?? []}
                rowKey={(r) => r.id}
                empty={t('noInstruction')}
                columns={[
                  { key: 'w', header: t('col.sent'), cell: (r) => fmt.dateTime(r.createdAt) },
                  { key: 't', header: t('col.title'), cell: (r) => (r.urgent ? t('titleUrgent', { title: r.title }) : r.title) },
                  {
                    key: 'a',
                    header: t('col.acknowledged'),
                    cell: (r) => t('acknowledged', { done: fmt.number(r.acknowledged), total: fmt.number(r.recipients) }),
                  },
                  { key: 's', header: t('col.state'), cell: (r) => (r.archivedAt ? t('archived') : t('live')) },
                ]}
              />
            </QueryState>
          </Card>
        </>
      ) : null}
    </>
  );
}
