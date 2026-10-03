'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Building,
  CreditCard,
  DoorOpen,
  FileWarning,
  HardHat,
  Inbox,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { countOf, fetchers, keys } from '@/lib/queries';

export default function OverviewPage() {
  const me = useQuery({ queryKey: keys.me, queryFn: fetchers.me });
  const units = useQuery({ queryKey: [...keys.units, 'count'], queryFn: () => fetchers.units(undefined, 100) });
  const residents = useQuery({ queryKey: [...keys.residents, 'count'], queryFn: () => fetchers.residents(undefined, 100) });
  const [today] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  });
  const todayEntries = useQuery({
    queryKey: keys.entries({ from: today, count: true }),
    queryFn: () => fetchers.entries({ from: today }, undefined, 100),
    refetchInterval: 30_000,
  });
  const registrations = useQuery({ queryKey: [...keys.registrations, 'count'], queryFn: () => fetchers.registrations(undefined, 100) });
  const household = useQuery({ queryKey: [...keys.household, 'count'], queryFn: () => fetchers.household(undefined, 100) });
  const workers = useQuery({
    queryKey: [...keys.engagements('pending_review'), 'count'],
    queryFn: () => fetchers.engagements('pending_review', undefined, 100),
  });
  const review = useQuery({ queryKey: [...keys.unitsReview, 'count'], queryFn: () => fetchers.unitsReview(undefined, 100) });
  const compliance = useQuery({ queryKey: [...keys.compliance('open'), 'count'], queryFn: () => fetchers.compliance('open', undefined, 100) });
  const incidents = useQuery({ queryKey: [...keys.incidents('open'), 'count'], queryFn: () => fetchers.incidents('open', undefined, 100) });
  const entries = useQuery({ queryKey: keys.entries({ overview: true }), queryFn: () => fetchers.entries({}, undefined, 8), refetchInterval: 30_000 });
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates });

  const gateNames = useMemo(() => new Map((gates.data?.data ?? []).map((g) => [g.id, g.name])), [gates.data]);
  const openRequests =
    registrations.data && household.data ? registrations.data.data.length + household.data.data.length : undefined;

  const queue = [
    ...(registrations.data?.data ?? []).slice(0, 4).map((r) => ({
      id: r.id,
      title: r.fullName,
      meta: `Wants to join unit ${r.unitCode} as ${r.occupancyType}`,
      when: r.createdAt,
      href: '/requests',
      tag: 'Registration',
      warn: r.conflicts.length > 0,
    })),
    ...(household.data?.data ?? []).slice(0, 4).map((m) => ({
      id: m.memberId,
      title: m.fullName ?? 'Household member',
      meta: `${humanize(m.relation)} · unit ${m.unitCode}`,
      when: m.requestedAt,
      href: '/requests?tab=household',
      tag: 'Household',
      warn: false,
    })),
    ...(workers.data?.data ?? []).slice(0, 4).map((w) => ({
      id: w.id,
      title: w.workerName,
      meta: `${humanize(w.capacity)} · unit ${w.unitCode}`,
      when: w.createdAt,
      href: '/workers',
      tag: 'Worker',
      warn: !w.birthDateVerified,
    })),
  ].sort((a, b) => a.when.localeCompare(b.when));

  return (
    <>
      <PageHeader
        title={me.data?.fullName ? `Hello, ${me.data.fullName.split(' ')[0]}` : 'Overview'}
        description="What needs a decision today, and what is happening at the gate."
      />

      <div className="grid grid--stats">
        <Stat
          tone="dark"
          label="Gate entries today"
          icon={<DoorOpen aria-hidden />}
          value={countOf(todayEntries.data)}
          hint="Ins and outs since midnight"
          href="/gate"
        />
        <Stat
          tone={openRequests ? 'beige' : 'green'}
          label="Open requests"
          icon={<Inbox aria-hidden />}
          value={openRequests ?? '—'}
          hint="Registrations and household members"
          href="/requests"
        />
        <Stat label="Units" icon={<Building aria-hidden />} value={countOf(units.data)} href="/units" />
        <Stat label="Residents" icon={<Users aria-hidden />} value={countOf(residents.data)} href="/residents" />
      </div>
      <div className="grid grid--stats">
        <Stat label="Workers to review" icon={<HardHat aria-hidden />} value={countOf(workers.data)} href="/workers" />
        <Stat label="Units under review" icon={<TriangleAlert aria-hidden />} value={countOf(review.data)} href="/units?tab=review" />
        <Stat label="Compliance cases" icon={<FileWarning aria-hidden />} value={countOf(compliance.data)} hint="Open" href="/workers?tab=compliance" />
        <Stat label="Card incidents" icon={<CreditCard aria-hidden />} value={countOf(incidents.data)} hint="Open" href="/workers?tab=incidents" />
      </div>

      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader
            title="Needs your decision"
            actions={
              <ButtonLink href="/requests" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                All requests
              </ButtonLink>
            }
          >
            <span className="t-secondary">Oldest first.</span>
          </CardHeader>
          <QueryState query={registrations}>
            {queue.length ? (
              <ul className="list">
                {queue.map((item) => (
                  <li key={item.tag + item.id} className="list__item">
                    <Badge tone={item.tag === 'Worker' ? 'beige' : 'green'} plain>
                      {item.tag}
                    </Badge>
                    <div className="list__text">
                      <Link href={item.href} className="list__title table__link" style={{ display: 'block' }}>
                        {item.title}
                      </Link>
                      <div className="list__meta">{item.meta}</div>
                    </div>
                    {item.warn ? <Badge tone="terracotta">Check</Badge> : null}
                    <span className="list__meta" title={formatDateTime(item.when)}>
                      {relativeTime(item.when)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="All clear">No registration, household or worker is waiting.</EmptyState>
            )}
          </QueryState>
        </Card>

        <Card flush>
          <CardHeader
            title="Latest at the gate"
            actions={
              <ButtonLink href="/gate?tab=entries" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                Log
              </ButtonLink>
            }
          />
          <QueryState query={entries} rows={4}>
            {entries.data?.data.length ? (
              <ul className="list">
                {entries.data.data.map((e) => (
                  <li key={e.id} className="list__item">
                    <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? 'In' : 'Out'}</Badge>
                    <div className="list__text">
                      <div className="list__title">
                        {humanize(e.subjectType === 'worker_engagement' ? 'worker' : e.subjectType === 'visitor_pass' ? 'visitor' : 'approved visit')}{' '}
                        · {e.unitCode}
                      </div>
                      <div className="list__meta">
                        {gateNames.get(e.gateId) ?? 'Gate'} · {humanize(e.method)}
                      </div>
                    </div>
                    <span className="list__meta" title={formatDateTime(e.occurredAt)}>
                      {relativeTime(e.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No entries yet" />
            )}
          </QueryState>
        </Card>
      </div>
    </>
  );
}
