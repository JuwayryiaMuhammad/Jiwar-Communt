'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { CertificatesTab, LocationTab, ReinforcementTab } from './part-b';

interface Ref {
  id: string;
  fullName?: string | null;
}
interface DutySlot {
  id: string;
  technician: Ref;
  zone: { nameEn: string } | null;
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
const name = (r: Ref | null) => (r ? (r.fullName ?? 'Erased') : '—');
const list = <T,>(res: unknown) => (res as { data: T[] }).data;

/**
 * The field team (ADR 0078): calls for help to take, the technicians'
 * roster and attendance (the guards' roster, the maintenance crew), and
 * the instructions every technician acknowledges.
 */
export default function FieldTeamPage() {
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
    { invalidate: [['field-team']], onDone: () => toast.show('Taken; the technician is told.') },
  );
  const resolve = useAction(
    (id: string) =>
      unwrap(api.POST('/api/v1/staff/field-team/help-requests/{id}/resolve', { params: { path: { id } } })),
    { invalidate: [['field-team']], onDone: () => toast.show('Resolved.') },
  );
  const [slot, setSlot] = useState({ technicianId: '', startsAt: '', hours: '8' });
  const addSlot = useAction(
    () => {
      const startsAt = new Date(slot.startsAt);
      return unwrap(
        api.POST('/api/v1/staff/field-team/roster/slots', {
          body: {
            technicianId: slot.technicianId,
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + Number(slot.hours) * 3_600_000).toISOString(),
          },
        }),
      );
    },
    { invalidate: [['field-team']], onDone: () => toast.show('Slot added.') },
  );
  const [words, setWords] = useState({ title: '', body: '', urgent: false });
  const send = useAction(
    () => unwrap(api.POST('/api/v1/staff/field-team/instructions', { body: words })),
    {
      invalidate: [['field-team']],
      onDone: () => {
        toast.show('Sent to every technician.');
        setWords({ title: '', body: '', urgent: false });
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Field team" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Field team"
        description="Technicians' calls for help, their roster and attendance, the instructions they acknowledge, reinforcement at peaks, the staff's certificates and a technician's last known location."
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        {TABS.map((t) => (
          <Button key={t} size="sm" variant={t === tab ? 'primary' : undefined} onClick={() => setTab(t)}>
            {t === 'help' ? 'Calls for help' : humanize(t)}
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
              empty="No call for help"
              columns={[
                { key: 'w', header: 'When', cell: (r) => formatDateTime(r.createdAt) },
                { key: 'k', header: 'Kind', cell: (r) => humanize(r.kind) },
                { key: 'r', header: 'Technician', cell: (r) => name(r.requester) },
                { key: 't', header: 'Ticket', cell: (r) => r.ticket?.number ?? '—' },
                { key: 'n', header: 'Note', cell: (r) => r.note ?? '' },
                {
                  key: 's',
                  header: 'Status',
                  cell: (r) => `${humanize(r.status)}${r.escalatedAt ? ' (escalated)' : ''}`,
                },
                { key: 'h', header: 'Helper', cell: (r) => name(r.helper) },
                {
                  key: 'x',
                  header: <span className="visually-hidden">Actions</span>,
                  className: 'table__actions',
                  cell: (r) =>
                    r.status === 'open' ? (
                      <span className="row" style={{ gap: 6 }}>
                        <Select
                          aria-label="Send a technician"
                          value={helper[r.id] ?? ''}
                          onChange={(e) => setHelper({ ...helper, [r.id]: e.target.value })}
                        >
                          <option value="">No one sent</option>
                          {(technicians.data ?? [])
                            .filter((t) => t.id !== r.requester.id)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.fullName}
                              </option>
                            ))}
                        </Select>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={take.isPending}
                          onClick={() => take.mutate({ id: r.id, helperId: helper[r.id] || undefined })}
                        >
                          Take
                        </Button>
                      </span>
                    ) : r.status === 'taken' ? (
                      <Button size="sm" loading={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
                        Resolved
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
            <CardHeader title="Add a slot" />
            <CardBody>
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label="Technician">
                  {(p) => (
                    <Select {...p} value={slot.technicianId} onChange={(e) => setSlot({ ...slot, technicianId: e.target.value })}>
                      <option value="">Choose</option>
                      {(technicians.data ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.fullName}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Starts">
                  {(p) => (
                    <Input
                      {...p}
                      type="datetime-local"
                      value={slot.startsAt}
                      onChange={(e) => setSlot({ ...slot, startsAt: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Hours">
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
                  Add
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
                empty="No slot in the next two weeks"
                columns={[
                  { key: 't', header: 'Technician', cell: (r) => name(r.technician) },
                  { key: 'z', header: 'Zone', cell: (r) => r.zone?.nameEn ?? 'Whole compound' },
                  { key: 's', header: 'Starts', cell: (r) => formatDateTime(r.startsAt) },
                  { key: 'e', header: 'Ends', cell: (r) => formatDateTime(r.endsAt) },
                  {
                    key: 'd',
                    header: 'On duty',
                    cell: (r) =>
                      r.status === 'cancelled'
                        ? 'Cancelled'
                        : r.dutyStartedAt
                          ? `${formatDateTime(r.dutyStartedAt)}${r.late ? ' (late)' : ''}`
                          : r.absentAt
                            ? 'Absent'
                            : '—',
                  },
                  { key: 'o', header: 'Overtime', cell: (r) => (r.overtimeMinutes ? `${r.overtimeMinutes} min` : '') },
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
              empty="No slot in the period"
              columns={[
                { key: 't', header: 'Technician', cell: (r) => name(r.technician) },
                { key: 's', header: 'Slots', cell: (r) => r.slots },
                { key: 'f', header: 'On duty', cell: (r) => r.filled },
                { key: 'l', header: 'Late', cell: (r) => r.late },
                { key: 'a', header: 'Absent', cell: (r) => r.absent },
                { key: 'w', header: 'Worked (min)', cell: (r) => r.workedMinutes },
                { key: 'o', header: 'Overtime (min)', cell: (r) => r.overtimeMinutes },
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
            <CardHeader title="Send every technician an instruction" />
            <CardBody>
              <Field label="Title">
                {(p) => <Input {...p} maxLength={120} value={words.title} onChange={(e) => setWords({ ...words, title: e.target.value })} />}
              </Field>
              <Field label="Instruction">
                {(p) => (
                  <Textarea {...p} maxLength={4000} rows={4} value={words.body} onChange={(e) => setWords({ ...words, body: e.target.value })} />
                )}
              </Field>
              <Checkbox label="Urgent: a critical push" checked={words.urgent} onChange={(e) => setWords({ ...words, urgent: e.target.checked })} />
              <ErrorAlert error={send.error} />
              <Button variant="primary" disabled={!words.title || !words.body} loading={send.isPending} onClick={() => send.mutate()}>
                Send
              </Button>
            </CardBody>
          </Card>
          <Card flush>
            <QueryState query={instructions}>
              <DataTable<Instruction>
                rows={instructions.data ?? []}
                rowKey={(r) => r.id}
                empty="No instruction yet"
                columns={[
                  { key: 'w', header: 'Sent', cell: (r) => formatDateTime(r.createdAt) },
                  { key: 't', header: 'Title', cell: (r) => `${r.title}${r.urgent ? ' (urgent)' : ''}` },
                  { key: 'a', header: 'Acknowledged', cell: (r) => `${r.acknowledged} of ${r.recipients}` },
                  { key: 's', header: 'State', cell: (r) => (r.archivedAt ? 'Archived' : 'Live') },
                ]}
              />
            </QueryState>
          </Card>
        </>
      ) : null}
    </>
  );
}
