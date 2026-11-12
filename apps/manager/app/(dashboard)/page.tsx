'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, ButtonLink, Card, CardHeader, DataTable, EmptyState, PageHeader, Stat, useLabel } from '@jiwar/ui';
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
import { liquidityDays } from '@/components/finance/cash-flow';
import { INBOX_TYPE } from '@/components/inbox/inbox-types';
import { useInboxText } from '@/components/inbox/use-inbox-text';
import { BAND_TONE, alertHref, alertText, bandText } from '@/components/operations/dashboard';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BuildingStatus } from '@/lib/queries';
import { useNow } from '@/lib/use-now';
import finAr from '@/messages/ar/fin-codes';
import ar from '@/messages/ar/shell-overview';
import finEn from '@/messages/en/fin-codes';
import en from '@/messages/en/shell-overview';

/**
 * The operations dashboard (ADR 0079): the cards in one call, what needs
 * me now, and every building's status. Each card shows only to a role that
 * reads its section; the server leaves the others null.
 */
export default function OverviewPage() {
  const t = useT(en, ar);
  const finT = useT(finEn, finAr);
  const inbox = useInboxText();
  const fmt = useFormat();
  const label = useLabel();
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
  const n = (x: number) => fmt.number(x);

  return (
    <>
      <PageHeader
        title={me.data?.fullName ? t('hello', { name: me.data.fullName.split(' ')[0] }) : t('title')}
        description={summary.data ? t('description', { date: fmt.day(summary.data.date) }) : undefined}
        actions={
          can('dashboard.read') ? (
            <ButtonLink href="/briefs" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
              {t('briefs')}
            </ButtonLink>
          ) : null
        }
      />

      <QueryState query={summary} rows={2}>
        <div className="grid grid--stats">
          {summary.data?.inbox ? (
            <Stat
              tone={summary.data.inbox.overdue ? 'beige' : 'green'}
              label={t('inbox.label')}
              icon={<Inbox aria-hidden />}
              value={n(summary.data.inbox.total)}
              hint={t('inbox.hint', { n: summary.data.inbox.overdue })}
              href="/inbox"
            />
          ) : null}
          {m ? (
            <>
              <Stat
                tone="dark"
                label={t('tickets.label')}
                icon={<Wrench aria-hidden />}
                value={n(m.open)}
                hint={t('tickets.hint', { unassigned: m.unassigned, awaiting: m.awaitingConfirmation })}
                href="/maintenance"
              />
              <Stat
                tone={m.overdue ? 'beige' : undefined}
                label={t('sla.label')}
                icon={<TriangleAlert aria-hidden />}
                value={m.slaEnabled ? n(m.overdue) : '—'}
                hint={m.slaEnabled ? t('sla.hint', { n: m.atRisk }) : t('sla.off')}
                href="/maintenance"
              />
              <Stat
                label={t('emergencies.label')}
                icon={<Siren aria-hidden />}
                value={n(m.emergencyOpen)}
                hint={m.emergencyUnassigned ? t('emergencies.hint', { n: m.emergencyUnassigned }) : t('emergencies.allAssigned')}
                href="/maintenance"
              />
            </>
          ) : null}
        </div>
        <div className="grid grid--stats">
          {money ? (
            <>
              <Stat
                label={t('collected.label')}
                icon={<Banknote aria-hidden />}
                value={fmt.percent(money.collectionRate)}
                hint={t('collected.hint', { month: fmt.money(money.collectedMonth), today: fmt.money(money.collectedToday) })}
                href="/finance"
              />
              <Stat
                label={t('owed.label')}
                icon={<Wallet aria-hidden />}
                value={fmt.money(money.overdueAmount)}
                hint={t('owed.hint', { n: money.overdueInvoices })}
                href="/finance"
              />
            </>
          ) : null}
          {can('finance.cashflow') ? (
            <Stat
              label={t('liquidity.label')}
              icon={<Wallet aria-hidden />}
              value={liquidityDays(finT, summary.data?.liquidityDays)}
              hint={t('liquidity.hint')}
              href="/finance/cash-flow"
            />
          ) : null}
          {f?.security ? (
            <Stat
              tone={f.security.lockdownsLive ? 'beige' : undefined}
              label={t('incidents.label')}
              icon={<ShieldAlert aria-hidden />}
              value={n(f.security.incidentsToday)}
              hint={
                f.security.lockdownsLive
                  ? t('incidents.hintLockdown', { open: f.security.incidentsOpen, lockdowns: f.security.lockdownsLive })
                  : t('incidents.hint', { open: f.security.incidentsOpen })
              }
              href="/security/incidents"
            />
          ) : null}
          {f?.gate ? (
            <Stat
              label={t('gate.label')}
              icon={<DoorOpen aria-hidden />}
              value={n(f.gate.entriesToday)}
              hint={t('gate.hint', { visitors: f.gate.visitorsToday, exits: f.gate.exitsToday })}
              href="/gate/traffic"
            />
          ) : null}
          {f?.energy ? (
            <Stat
              label={t('outages.label')}
              icon={<ZapOff aria-hidden />}
              value={n(f.energy.outagesActive)}
              hint={t('outages.hint', { n: f.energy.outagesLaterToday })}
              href="/outages"
            />
          ) : null}
          {f?.units ? (
            <Stat
              label={t('units.label')}
              icon={<Building aria-hidden />}
              value={n(f.units.units)}
              hint={t('units.hint', { occupied: f.units.occupied, vacant: f.units.vacant, closed: f.units.closed })}
              href="/units"
            />
          ) : null}
        </div>
      </QueryState>

      <div className="grid grid--main-aside">
        <Card flush>
          <CardHeader
            title={t('needsTitle')}
            actions={
              can('inbox.read') ? (
                <ButtonLink href="/inbox" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                  {t('inbox')}
                </ButtonLink>
              ) : null
            }
          >
            <span className="t-secondary">{t('needsHint')}</span>
          </CardHeader>
          <QueryState query={needs}>
            {alerts.length || items.length ? (
              <ul className="list">
                {alerts.map((a) => (
                  <li key={`${a.section}:${a.code}`} className="list__item">
                    <Badge tone={a.severity === 'critical' ? 'terracotta' : 'beige'}>
                      {a.severity === 'critical' ? t('severity.critical') : t('severity.warning')}
                    </Badge>
                    <div className="list__text">
                      <Link href={alertHref(a.code)} className="list__title table__link" style={{ display: 'block' }}>
                        {alertText(t, a.code, a.count)}
                      </Link>
                      <div className="list__meta">{label(a.section)}</div>
                    </div>
                  </li>
                ))}
                {items.map((i) => (
                  <li key={`${i.type}:${i.id}`} className="list__item">
                    <Badge tone={i.overdue ? 'terracotta' : 'green'} plain>
                      {inbox.type(i.type)}
                    </Badge>
                    <div className="list__text">
                      <Link
                        href={INBOX_TYPE[i.type]?.href(i.id) ?? '/inbox'}
                        className="list__title table__link"
                        style={{ display: 'block' }}
                      >
                        {i.number ?? inbox.type(i.type)}
                      </Link>
                      <div className="list__meta">
                        {i.overdue ? t('overdueSince', { when: fmt.dateTime(i.dueAt) }) : t('due', { when: fmt.dateTime(i.dueAt) })}
                      </div>
                    </div>
                    <span className="list__meta" title={fmt.dateTime(i.requestedAt)}>
                      {inbox.waited(i.requestedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t('allClear')}>{t('allClearBody')}</EmptyState>
            )}
          </QueryState>
        </Card>

        {can('gate.read') ? (
          <Card flush>
            <CardHeader
              title={t('gateTitle')}
              actions={
                <span className="row">
                  <ButtonLink href="/gate?tab=inside" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                    {typeof f?.gate?.insideNow === 'number' ? t('insideNowCount', { n: n(f.gate.insideNow) }) : t('insideNow')}
                  </ButtonLink>
                  <ButtonLink href="/gate?tab=entries" size="sm" variant="text" icon={<ArrowRight aria-hidden className="icon-dir" />}>
                    {t('log')}
                  </ButtonLink>
                </span>
              }
            />
            <QueryState query={entries} rows={4}>
              {entries.data?.data.length ? (
                <ul className="list">
                  {entries.data.data.map((e) => (
                    <li key={e.id} className="list__item">
                      <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? t('in') : t('out')}</Badge>
                      <div className="list__text">
                        <div className="list__title">
                          {e.subjectType === 'worker_engagement'
                            ? t('entry.worker')
                            : e.subjectType === 'visitor_pass'
                              ? t('entry.visitor')
                              : t('entry.visit')}{' '}
                          · <bdi>{e.unitCode}</bdi>
                        </div>
                        <div className="list__meta">
                          {gateNames.get(e.gateId) ?? t('gate')} · {label(e.method)}
                        </div>
                      </div>
                      <span className="list__meta" title={fmt.dateTime(e.occurredAt)}>
                        {fmt.relative(e.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t('noEntries')} />
              )}
            </QueryState>
          </Card>
        ) : null}
      </div>

      <Card flush>
        <CardHeader title={t('buildingsTitle')}>
          <span className="t-secondary">{t('buildingsHint')}</span>
        </CardHeader>
        <QueryState query={buildings}>
          <DataTable<BuildingStatus>
            rows={buildings.data?.buildings ?? []}
            rowKey={(b) => b.id}
            empty={t('noBuildings')}
            columns={[
              { key: 'name', header: t('col.building'), cell: (b) => <Link href={`/units?buildingId=${b.id}`}>{b.name}</Link> },
              {
                key: 'band',
                header: t('col.status'),
                cell: (b) => <Badge tone={BAND_TONE[b.band] ?? 'beige'}>{bandText(t, b.band)}</Badge>,
              },
              { key: 'units', header: t('col.occupied'), cell: (b) => (b.units ? `${n(b.units.occupied)} / ${n(b.units.units)}` : '—') },
              { key: 'open', header: t('col.open'), cell: (b) => (b.maintenance ? n(b.maintenance.open) : '—') },
              { key: 'overdue', header: t('col.overdue'), cell: (b) => (b.maintenance ? n(b.maintenance.overdue) : '—') },
              { key: 'emergency', header: t('col.emergency'), cell: (b) => (b.maintenance ? n(b.maintenance.emergencyOpen) : '—') },
              { key: 'outages', header: t('col.outages'), cell: (b) => (b.energy ? n(b.energy.outagesActive) : '—') },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
