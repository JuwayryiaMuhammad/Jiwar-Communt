'use client';

import { formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, ForbiddenState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Event = Schema<'ControlRoomEventView'>;
type Post = Schema<'ControlRoomPostView'>;
type Filter = 'open' | 'all';
const EVENTS = ['control-room', 'events'] as const;
const POSTS = ['control-room', 'posts'] as const;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'To acknowledge' },
  { value: 'all', label: 'All' },
];

/** What happened, in words: the event's code only. */
const KIND_TEXT: Record<string, string> = {
  guard_sos_raised: 'A guard raised an SOS',
  guard_sos_escalated: 'A guard’s SOS has no responder yet',
  guard_alarm: 'A guard’s wearable raised an alarm',
  guard_alarm_unpaired: 'A wearable nobody wears raised an alarm',
  lockdown_started: 'A lockdown started',
  lockdown_ended: 'A lockdown ended',
  blocklist_match: 'The blocklist was met at the gate',
  field_exception_raised: 'A guard asks to let someone in',
  patrol_geofence_exit: 'A patrol left its area',
  device_sync_overdue: 'A gate device stopped syncing',
  gate_call_missed: 'A call from the gate was not answered',
};
/** Where the event's source opens in the dashboard, when it does. */
const sourceHref = (e: Event): string | null =>
  e.sourceType === 'lockdown'
    ? `/security/lockdowns`
    : e.sourceType === 'gate_field_exception'
      ? `/security/field-exceptions?exception=${e.sourceId}`
      : e.sourceType === 'gate_device'
        ? `/security/gate-devices?device=${e.sourceId}`
        : e.sourceType === 'emergency'
          ? `/emergencies?emergency=${e.sourceId}`
          : null;

function Posts() {
  const posts = useQuery({ queryKey: POSTS, queryFn: () => unwrap(api.GET('/api/v1/staff/control-room/posts')), refetchInterval: 30_000 });
  return (
    <Card flush>
      <CardHeader title="Posts" />
      <QueryState query={posts}>
        <DataTable<Post>
          rows={posts.data?.data}
          rowKey={(p) => p.id}
          empty="No gate or zone in service"
          columns={[
            { key: 'n', header: 'Post', cell: (p) => `${p.nameEn}${p.kind === 'zone' ? ' (zone)' : ''}` },
            {
              key: 'g',
              header: 'On duty',
              cell: (p) =>
                p.shift ? (
                  <span>
                    {p.shift.guard.fullName ?? 'A guard'} since {formatDateTime(p.shift.startedAt)}
                    {p.shift.alarmPaired ? null : (
                      <>
                        {' '}
                        <Badge tone="beige">No wearable</Badge>
                      </>
                    )}
                  </span>
                ) : (
                  <Badge tone="error">Nobody</Badge>
                ),
            },
            { key: 'l', header: 'Locked down', cell: (p) => (p.lockedDown ? <Badge tone="error">Locked</Badge> : '—') },
            { key: 'x', header: 'Waiting exceptions', cell: (p) => p.openExceptions || '—' },
            { key: 'e', header: 'Open SOS', cell: (p) => (p.openEmergencies ? <Badge tone="error">{p.openEmergencies}</Badge> : '—') },
          ]}
        />
      </QueryState>
    </Card>
  );
}

/**
 * The control room (ADR 0068), `control_room.watch`: the guards’ SOS and
 * alarms, lockdowns, the blocklist met at the gate, field exceptions,
 * patrols out of their area, devices out of sync and missed gate calls —
 * each acknowledged once — and the posts at a glance.
 */
export default function ControlRoomPage() {
  return (
    <Suspense>
      <ControlRoom />
    </Suspense>
  );
}

function ControlRoom() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('control_room.watch');
  const focus = useSearchParams().get('event');
  const [filter, setFilter] = useState<Filter>('open');
  const events = useQuery({
    queryKey: [...EVENTS, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/control-room/events', { params: { query: filter === 'open' ? { status: 'open' } : {} } })),
    enabled: allowed,
    refetchInterval: 15_000,
  });
  const ack = useAction((id: string) => unwrap(api.POST('/api/v1/staff/control-room/events/{id}/acknowledge', { params: { path: { id } } })), {
    invalidate: [EVENTS],
    onDone: () => toast.show('Acknowledged.'),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Control room" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Control room" description="What the guards and the gates need from you, as it happens." />
      <div className="stack">
        <Posts />
        <Card flush>
          <CardHeader title="Events" actions={<Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />} />
          <CardBody>
            <ErrorAlert error={ack.error} />
          </CardBody>
          <QueryState query={events}>
            <DataTable<Event>
              rows={events.data?.data}
              rowKey={(e) => e.id}
              empty={filter === 'open' ? 'Nothing to acknowledge' : 'Nothing yet'}
              columns={[
                {
                  key: 'k',
                  header: 'What',
                  cell: (e) => {
                    const href = sourceHref(e);
                    const text = KIND_TEXT[e.kind] ?? e.kind;
                    return (
                      <span style={e.id === focus ? { fontWeight: 600 } : undefined}>
                        {e.severity === 'high' ? <Badge tone="error">Alert</Badge> : null} {href ? <Link href={href}>{text}</Link> : text}
                      </span>
                    );
                  },
                },
                { key: 't', header: 'When', cell: (e) => formatDateTime(e.occurredAt) },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (e) =>
                    e.acknowledgedAt ? (
                      `Acknowledged by ${e.acknowledgedBy?.fullName ?? 'someone'}`
                    ) : (
                      <Button size="sm" variant="primary" loading={ack.isPending && ack.variables === e.id} onClick={() => ack.mutate(e.id)}>
                        Acknowledge
                      </Button>
                    ),
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
    </>
  );
}
