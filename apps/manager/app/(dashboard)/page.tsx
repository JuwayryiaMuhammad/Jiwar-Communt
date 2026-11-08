'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardHeader, DataTable, EmptyState, PageHeader, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Banknote,
  Building,
  DoorOpen,
  Inbox,
  Siren,
  ShieldAlert,
  TriangleAlert,
  Wallet,
  Wrench,
  ZapOff,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { liquidityText } from '@/components/finance/cash-flow';
import { INBOX_TYPE, inboxLabel, waited } from '@/components/inbox/inbox-types';
import { ALERT, BAND, alertText, percent } from '@/components/operations/dashboard';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BuildingStatus } from '@/lib/queries';
import { useNow } from '@/lib/use-now';

/**
 * The operations dashboard (ADR 0079): the cards in one call, what needs
 * me now, and every building's status. Each card shows only to a role that
 * reads its section; the server leaves the others null.
 */
export default function OverviewPage() {
  const { can } = usePermissions();
  const now = useNow(60_000);
  const me = useQuery({ queryKey: keys.me, queryFn: fetchers.me });
  const summary = useQuery({ queryKey: keys.dashboard, queryFn: fetchers.dashboard, refetchInterval: 60_000 });
  const needs = useQuery({ queryKey: keys.needsYou, queryFn: fetchers.needsYou, refetchInterval: 60_000 });
  const buildings = useQuery({ queryKey: keys.buildingsStatus, queryFn: fetchers.buildingsStatus, refetchInterval: 120_000 });
  const entries = useQuery({
    queryKey: keys.entries({ overview: true }),
    queryFn: () => fetchers.entries({}, undefined, 8),
    refetchInterval: 30_000,
    enabled: can('gate.read'),
  });
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates, enabled: can('gate.read') });
  const gateNames = useMemo(() => new Map((gates.data?.data ?? []).map((g) => [g.id, g.name])), [gates.data]);

  const f = summary.data?.figures;
  const m = f?.maintenance;
  const money = f?.finance;
  const alerts = needs.data?.alerts ?? [];
  const items = needs.data?.items ?? [];

  return (
    <>
      <PageHeader
        title={me.data?.fullName ? `Hello, ${me.data.fullName.split(' ')[0]}` : 'Overview'}
        description={
          summary.data
            ? `The compound’s day, ${summary.data.date}. What needs you, and how each part of the compound is doing.`
            : undefined
        }
        actions={
          can('dashboard.read') ? (
            <ButtonLink href="/briefs" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
              Daily briefs
            </ButtonLink>
          ) : null
        }
      />

      <QueryState query={summary} rows={2}>
        <div className="grid grid--stats">
          {summary.data?.inbox ? (
            <Stat
              tone={summary.data.inbox.overdue ? 'beige' : 'green'}
              label="Waiting for you"
              icon={<Inbox aria-hidden />}
              value={summary.data.inbox.total}
              hint={`${summary.data.inbox.overdue} overdue`}
              href="/inbox"
            />
          ) : null}
          {m ? (
            <>
              <Stat
                tone="dark"
                label="Open tickets"
                icon={<Wrench aria-hidden />}
                value={m.open}
                hint={`${m.unassigned} unassigned · ${m.awaitingConfirmation} awaiting the resident`}
                href="/maintenance"
              />
              <Stat
                tone={m.overdue ? 'beige' : undefined}
                label="Past the SLA"
                icon={<TriangleAlert aria-hidden />}
                value={m.slaEnabled ? m.overdue : '—'}
                hint={m.slaEnabled ? `${m.atRisk} at risk` : 'The SLA is off'}
                href="/maintenance"
              />
              <Stat
                label="Emergencies open"
                icon={<Siren aria-hidden />}
                value={m.emergencyOpen}
                hint={m.emergencyUnassigned ? `${m.emergencyUnassigned} unassigned` : 'All assigned'}
                href="/maintenance"
              />
            </>
          ) : null}
        </div>
        <div className="grid grid--stats">
          {money ? (
            <>
              <Stat
                label="Collected this month"
                icon={<Banknote aria-hidden />}
                value={percent(money.collectionRate)}
                hint={`${money.collectedMonth} ${money.currency} · ${money.collectedToday} today`}
                href="/finance"
              />
              <Stat
                label="Owed past its day"
                icon={<Wallet aria-hidden />}
                value={money.overdueAmount}
                hint={`${money.overdueInvoices} invoice${money.overdueInvoices === 1 ? '' : 's'}`}
                href="/finance"
              />
            </>
          ) : null}
          {can('finance.cashflow') ? (
            <Stat
              label="Liquidity"
              icon={<Wallet aria-hidden />}
              value={liquidityText(summary.data?.liquidityDays)}
              hint="Days of spending the cash covers"
              href="/finance/cash-flow"
            />
          ) : null}
          {f?.security ? (
            <Stat
              tone={f.security.lockdownsLive ? 'beige' : undefined}
              label="Incidents today"
              icon={<ShieldAlert aria-hidden />}
              value={f.security.incidentsToday}
              hint={`${f.security.incidentsOpen} open${f.security.lockdownsLive ? ` · ${f.security.lockdownsLive} lockdown` : ''}`}
              href="/security/incidents"
            />
          ) : null}
          {f?.gate ? (
            <Stat
              label="Gate entries today"
              icon={<DoorOpen aria-hidden />}
              value={f.gate.entriesToday}
              hint={`${f.gate.visitorsToday} visitors · ${f.gate.exitsToday} out`}
              href="/gate/traffic"
            />
          ) : null}
          {f?.energy ? (
            <Stat
              label="Outages in force"
              icon={<ZapOff aria-hidden />}
              value={f.energy.outagesActive}
              hint={`${f.energy.outagesLaterToday} later today`}
              href="/outages"
            />
          ) : null}
          {f?.units ? (
            <Stat
              label="Units"
              icon={<Building aria-hidden />}
              value={f.units.units}
              hint={`${f.units.occupied} occupied · ${f.units.vacant} vacant · ${f.units.closed} closed`}
              href="/units"
            />
          ) : null}
        </div>
      </QueryState>

      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader
            title="Needs you now"
            actions={
              can('inbox.read') ? (
                <ButtonLink href="/inbox" size="sm" variant="text" icon={<ArrowRight aria-hidden />}>
                  Inbox
                </ButtonLink>
              ) : null
            }
          >
            <span className="t-secondary">The critical first, then what is overdue.</span>
          </CardHeader>
          <QueryState query={needs}>
            {alerts.length || items.length ? (
              <ul className="list">
                {alerts.map((a) => (
                  <li key={`${a.section}:${a.code}`} className="list__item">
                    <Badge tone={a.severity === 'critical' ? 'terracotta' : 'beige'}>
                      {a.severity === 'critical' ? 'Critical' : 'Warning'}
                    </Badge>
                    <div className="list__text">
                      <Link href={ALERT[a.code]?.href ?? '/'} className="list__title table__link" style={{ display: 'block' }}>
                        {alertText(a.code, a.count)}
                      </Link>
                      <div className="list__meta">{humanize(a.section)}</div>
                    </div>
                  </li>
                ))}
                {items.map((i) => (
                  <li key={`${i.type}:${i.id}`} className="list__item">
                    <Badge tone={i.overdue ? 'terracotta' : 'green'} plain>
                      {inboxLabel(i.type)}
                    </Badge>
                    <div className="list__text">
                      <Link
                        href={INBOX_TYPE[i.type]?.href(i.id) ?? '/inbox'}
                        className="list__title table__link"
                        style={{ display: 'block' }}
                      >
                        {i.number ?? inboxLabel(i.type)}
                      </Link>
                      <div className="list__meta">
                        {i.overdue ? 'Overdue since' : 'Due'} {formatDateTime(i.dueAt)}
                      </div>
                    </div>
                    <span className="list__meta" title={formatDateTime(i.requestedAt)}>
                      {waited(i.requestedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="All clear">Nothing critical, and nothing waits for your decision.</EmptyState>
            )}
          </QueryState>
        </Card>

        {can('gate.read') ? (
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
                          {humanize(
                            e.subjectType === 'worker_engagement'
                              ? 'worker'
                              : e.subjectType === 'visitor_pass'
                                ? 'visitor'
                                : 'approved visit',
                          )}{' '}
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
        ) : null}
      </div>

      <Card flush>
        <CardHeader title="Buildings">
          <span className="t-secondary">
            Critical with an outage in force or an emergency open; attention with a ticket past the SLA.
          </span>
        </CardHeader>
        <QueryState query={buildings}>
          <DataTable<BuildingStatus>
            rows={buildings.data?.buildings ?? []}
            rowKey={(b) => b.id}
            empty="No building in the register yet"
            columns={[
              { key: 'name', header: 'Building', cell: (b) => <Link href={`/units?buildingId=${b.id}`}>{b.name}</Link> },
              {
                key: 'band',
                header: 'Status',
                cell: (b) => <Badge tone={BAND[b.band]?.tone ?? 'beige'}>{BAND[b.band]?.label ?? b.band}</Badge>,
              },
              { key: 'units', header: 'Occupied', cell: (b) => (b.units ? `${b.units.occupied} / ${b.units.units}` : '—') },
              { key: 'open', header: 'Open tickets', cell: (b) => b.maintenance?.open ?? '—' },
              { key: 'overdue', header: 'Past the SLA', cell: (b) => b.maintenance?.overdue ?? '—' },
              { key: 'emergency', header: 'Emergencies', cell: (b) => b.maintenance?.emergencyOpen ?? '—' },
              { key: 'outages', header: 'Outages', cell: (b) => b.energy?.outagesActive ?? '—' },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
