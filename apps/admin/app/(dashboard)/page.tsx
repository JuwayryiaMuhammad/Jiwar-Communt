'use client';

import { formatDateTime, humanize, relativeTime, shortId } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Building2, PauseCircle, Plus, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { eventTone, isAlerting } from '@/lib/labels';
import { keys, listAudit, listEvents, listTenants } from '@/lib/queries';

/** "100+" when the first page is full and the API says there is more. */
function countOf(page: { data: unknown[]; nextCursor?: string | null } | undefined) {
  if (!page) return '—';
  return page.nextCursor ? `${page.data.length}+` : String(page.data.length);
}

export default function OverviewPage() {
  const [since] = useState(() => new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  const tenants = useQuery({ queryKey: [...keys.tenants, 'overview'], queryFn: () => listTenants(undefined, 100) });
  const events = useQuery({
    queryKey: keys.events({ from: since, overview: true }),
    queryFn: () => listEvents({ from: since }, undefined, 100),
    refetchInterval: 60_000,
  });
  const audit = useQuery({ queryKey: keys.audit({ overview: true }), queryFn: () => listAudit({}, undefined, 6) });

  const list = tenants.data?.data ?? [];
  const suspended = list.filter((t) => t.status === 'suspended').length;
  const alerts = (events.data?.data ?? []).filter((e) => isAlerting(e.event));
  const newest = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Compounds on the platform and what happened in the last 24 hours."
        actions={
          <ButtonLink href="/tenants?new=1" variant="primary" icon={<Plus aria-hidden />}>
            New compound
          </ButtonLink>
        }
      />

      <div className="grid grid--stats">
        <Stat
          tone="dark"
          label="Compounds"
          icon={<Building2 aria-hidden />}
          value={countOf(tenants.data)}
          hint={tenants.data ? `${list.length - suspended} active` : ' '}
          href="/tenants"
        />
        <Stat
          label="Suspended"
          icon={<PauseCircle aria-hidden />}
          value={tenants.data ? suspended : '—'}
          hint="Sign-in blocked for everyone inside"
          href="/tenants"
        />
        <Stat
          label="Security events · 24h"
          icon={<Activity aria-hidden />}
          value={countOf(events.data)}
          hint="Sign-ins, sessions, codes"
          href="/security-events"
        />
        <Stat
          tone={alerts.length ? 'beige' : 'green'}
          label="Needs a look · 24h"
          icon={<ShieldAlert aria-hidden />}
          value={events.data ? alerts.length : '—'}
          hint="Failed codes, lockouts, token reuse"
          href="/security-events"
        />
      </div>

      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader
            title="Recent security events"
            actions={
              <ButtonLink href="/security-events" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                All events
              </ButtonLink>
            }
          />
          <QueryState query={events}>
            {events.data?.data.length ? (
              <ul className="list">
                {events.data.data.slice(0, 8).map((e) => (
                  <li key={e.id} className="list__item">
                    <Badge tone={eventTone(e.event)}>{e.event}</Badge>
                    <div className="list__text">
                      <div className="list__meta">
                        {e.tenantId ? `Compound ${shortId(e.tenantId)}` : e.platformAdminId ? 'Platform' : 'No tenant'}
                        {e.ip ? ` · ${e.ip}` : ''}
                      </div>
                    </div>
                    <span className="list__meta t-num" title={formatDateTime(e.occurredAt)}>
                      {relativeTime(e.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Quiet day">No security events in the last 24 hours.</EmptyState>
            )}
          </QueryState>
        </Card>

        <div className="stack">
          <Card flush>
            <CardHeader
              title="Newest compounds"
              actions={
                <ButtonLink href="/tenants" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                  All
                </ButtonLink>
              }
            />
            <QueryState query={tenants} rows={3}>
              {newest.length ? (
                <ul className="list">
                  {newest.map((t) => (
                    <li key={t.id} className="list__item">
                      <div className="list__text">
                        <Link href={`/tenants/${t.id}`} className="list__title table__link" style={{ display: 'block' }}>
                          {t.name}
                        </Link>
                        <div className="list__meta">Opened {relativeTime(t.createdAt)}</div>
                      </div>
                      <StatusBadge status={t.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No compounds yet" />
              )}
            </QueryState>
          </Card>

          <Card flush>
            <CardHeader
              title="Latest platform actions"
              actions={
                <ButtonLink href="/audit" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                  Audit log
                </ButtonLink>
              }
            />
            <QueryState query={audit} rows={3}>
              {audit.data?.data.length ? (
                <ul className="list">
                  {audit.data.data.map((a) => (
                    <li key={a.id} className="list__item">
                      <div className="list__text">
                        <div className="list__title">{humanize(a.action)}</div>
                        <div className="list__meta">
                          {humanize(a.actorType)} · {relativeTime(a.occurredAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No actions yet" />
              )}
            </QueryState>
          </Card>
        </div>
      </div>
    </>
  );
}
