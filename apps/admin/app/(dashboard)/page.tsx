'use client';

import { shortId } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT, type Format } from '@jiwar/i18n';
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Building2, PauseCircle, Plus, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EventBadge } from '@/components/event-badge';
import { isAlerting, useCodeLabel } from '@/lib/labels';
import { keys, listAudit, listEvents, listTenants } from '@/lib/queries';
import ar from '@/messages/ar/overview';
import en from '@/messages/en/overview';

/** "100+" when the first page is full and the API says there is more. */
function countOf(fmt: Format, page: { data: unknown[]; nextCursor?: string | null } | undefined) {
  if (!page) return '—';
  const n = fmt.number(page.data.length);
  return page.nextCursor ? `${n}+` : n;
}

export default function OverviewPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useCodeLabel();
  const [since] = useState(() => new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  const tenants = useQuery({ queryKey: [...keys.tenants, 'overview'], queryFn: () => listTenants(undefined, 100) });
  const events = useQuery({
    queryKey: keys.events({ from: since, overview: true }),
    queryFn: () => listEvents({ from: since }, undefined, 100),
    refetchInterval: 60_000,
  });
  const audit = useQuery({ queryKey: keys.audit({ overview: true }), queryFn: () => listAudit({}, undefined, 6) });

  const list = tenants.data?.data ?? [];
  const suspended = list.filter((tenant) => tenant.status === 'suspended').length;
  const alerts = (events.data?.data ?? []).filter((e) => isAlerting(e.event));
  const newest = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <ButtonLink href="/tenants?new=1" variant="primary" icon={<Plus aria-hidden />}>
            {t('newCompound')}
          </ButtonLink>
        }
      />

      <div className="grid grid--stats">
        <Stat
          tone="dark"
          label={t('stat.compounds')}
          icon={<Building2 aria-hidden />}
          value={countOf(fmt, tenants.data)}
          hint={tenants.data ? t('stat.active', { n: list.length - suspended }) : ' '}
          href="/tenants"
        />
        <Stat
          label={t('stat.suspended')}
          icon={<PauseCircle aria-hidden />}
          value={tenants.data ? fmt.number(suspended) : '—'}
          hint={t('stat.suspendedHint')}
          href="/tenants"
        />
        <Stat
          label={t('stat.events')}
          icon={<Activity aria-hidden />}
          value={countOf(fmt, events.data)}
          hint={t('stat.eventsHint')}
          href="/security-events"
        />
        <Stat
          tone={alerts.length ? 'beige' : 'green'}
          label={t('stat.alerts')}
          icon={<ShieldAlert aria-hidden />}
          value={events.data ? fmt.number(alerts.length) : '—'}
          hint={t('stat.alertsHint')}
          href="/security-events"
        />
      </div>

      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader
            title={t('events.title')}
            actions={
              <ButtonLink href="/security-events" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                {t('events.all')}
              </ButtonLink>
            }
          />
          <QueryState query={events}>
            {events.data?.data.length ? (
              <ul className="list">
                {events.data.data.slice(0, 8).map((e) => (
                  <li key={e.id} className="list__item">
                    <EventBadge event={e.event} />
                    <div className="list__text">
                      <div className="list__meta">
                        {e.tenantId
                          ? t('events.compound', { id: shortId(e.tenantId) })
                          : e.platformAdminId
                            ? t('events.platform')
                            : t('events.noTenant')}
                        {e.ip ? (
                          <>
                            {' · '}
                            <bdi>{e.ip}</bdi>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <span className="list__meta t-num" title={fmt.dateTime(e.occurredAt)}>
                      {fmt.relative(e.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t('events.emptyTitle')}>{t('events.empty')}</EmptyState>
            )}
          </QueryState>
        </Card>

        <div className="stack">
          <Card flush>
            <CardHeader
              title={t('newest.title')}
              actions={
                <ButtonLink href="/tenants" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                  {c('all')}
                </ButtonLink>
              }
            />
            <QueryState query={tenants} rows={3}>
              {newest.length ? (
                <ul className="list">
                  {newest.map((tenant) => (
                    <li key={tenant.id} className="list__item">
                      <div className="list__text">
                        <Link href={`/tenants/${tenant.id}`} className="list__title table__link" style={{ display: 'block' }}>
                          {tenant.name}
                        </Link>
                        <div className="list__meta">{t('newest.opened', { when: fmt.relative(tenant.createdAt) })}</div>
                      </div>
                      <StatusBadge status={tenant.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t('newest.empty')} />
              )}
            </QueryState>
          </Card>

          <Card flush>
            <CardHeader
              title={t('actions.title')}
              actions={
                <ButtonLink href="/audit" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                  {t('actions.audit')}
                </ButtonLink>
              }
            />
            <QueryState query={audit} rows={3}>
              {audit.data?.data.length ? (
                <ul className="list">
                  {audit.data.data.map((a) => (
                    <li key={a.id} className="list__item">
                      <div className="list__text">
                        <div className="list__title">{label(a.action)}</div>
                        <div className="list__meta">
                          {label(a.actorType)} · {fmt.relative(a.occurredAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t('actions.empty')} />
              )}
            </QueryState>
          </Card>
        </div>
      </div>
    </>
  );
}
