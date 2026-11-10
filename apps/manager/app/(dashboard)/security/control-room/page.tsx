'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, ForbiddenState, PageHeader, Segmented, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { nameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/sec-control-room';
import en from '@/messages/en/sec-control-room';

type Event = Schema<'ControlRoomEventView'>;
type Post = Schema<'ControlRoomPostView'>;
type Filter = 'open' | 'all';
const EVENTS = ['control-room', 'events'] as const;
const POSTS = ['control-room', 'posts'] as const;

/** What happened, in words: the event's code only; an unknown code as it is. */
const kindText = (t: Translate<typeof en>, kind: string) => {
  const key = `kind.${kind}`;
  return key in en ? t(key as keyof typeof en) : kind;
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
  const t = useT(en, ar);
  const f = useFormat();
  const { locale } = useLocale();
  const posts = useQuery({ queryKey: POSTS, queryFn: () => unwrap(api.GET('/api/v1/staff/control-room/posts')), refetchInterval: 30_000 });
  return (
    <Card flush>
      <CardHeader title={t('posts')} />
      <QueryState query={posts}>
        <DataTable<Post>
          rows={posts.data?.data}
          rowKey={(p) => p.id}
          empty={t('postsEmpty')}
          columns={[
            {
              key: 'n',
              header: t('col.post'),
              cell: (p) => (p.kind === 'zone' ? t('zoneName', { name: nameIn(p, locale) }) : nameIn(p, locale)),
            },
            {
              key: 'g',
              header: t('col.onDuty'),
              cell: (p) =>
                p.shift ? (
                  <span>
                    {t('guardSince', { guard: p.shift.guard.fullName ?? t('aGuard'), since: f.dateTime(p.shift.startedAt) })}
                    {p.shift.alarmPaired ? null : (
                      <>
                        {' '}
                        <Badge tone="beige">{t('noWearable')}</Badge>
                      </>
                    )}
                  </span>
                ) : (
                  <Badge tone="error">{t('nobody')}</Badge>
                ),
            },
            { key: 'l', header: t('col.lockedDown'), cell: (p) => (p.lockedDown ? <Badge tone="error">{t('locked')}</Badge> : '—') },
            { key: 'x', header: t('col.waiting'), cell: (p) => (p.openExceptions ? f.number(p.openExceptions) : '—') },
            { key: 'e', header: t('col.sos'), cell: (p) => (p.openEmergencies ? <Badge tone="error">{f.number(p.openEmergencies)}</Badge> : '—') },
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('control_room.watch');
  const focus = useSearchParams().get('event');
  const [filter, setFilter] = useState<Filter>('open');
  const filters: { value: Filter; label: string }[] = [
    { value: 'open', label: t('filter.open') },
    { value: 'all', label: c('all') },
  ];
  const events = useQuery({
    queryKey: [...EVENTS, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/control-room/events', { params: { query: filter === 'open' ? { status: 'open' } : {} } })),
    enabled: allowed,
    refetchInterval: 15_000,
  });
  const ack = useAction((id: string) => unwrap(api.POST('/api/v1/staff/control-room/events/{id}/acknowledge', { params: { path: { id } } })), {
    invalidate: [EVENTS],
    onDone: () => toast.show(t('acknowledged')),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Posts />
        <Card flush>
          <CardHeader title={t('events')} actions={<Segmented label={t('show')} value={filter} onChange={setFilter} options={filters} />} />
          <CardBody>
            <ErrorAlert error={ack.error} />
          </CardBody>
          <QueryState query={events}>
            <DataTable<Event>
              rows={events.data?.data}
              rowKey={(e) => e.id}
              empty={filter === 'open' ? t('emptyOpen') : t('emptyAll')}
              columns={[
                {
                  key: 'k',
                  header: t('col.what'),
                  cell: (e) => {
                    const href = sourceHref(e);
                    const text = kindText(t, e.kind);
                    return (
                      <span style={e.id === focus ? { fontWeight: 600 } : undefined}>
                        {e.severity === 'high' ? <Badge tone="error">{t('alert')}</Badge> : null} {href ? <Link href={href}>{text}</Link> : text}
                      </span>
                    );
                  },
                },
                { key: 't', header: t('col.when'), cell: (e) => f.dateTime(e.occurredAt) },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (e) =>
                    e.acknowledgedAt ? (
                      t('acknowledgedBy', { name: e.acknowledgedBy?.fullName ?? t('someone') })
                    ) : (
                      <Button size="sm" variant="primary" loading={ack.isPending && ack.variables === e.id} onClick={() => ack.mutate(e.id)}>
                        {t('acknowledge')}
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
