'use client';

import { formatDate } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, CardBody, CardHeader, Field, ForbiddenState, Input, PageHeader, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/**
 * The safety KPIs (ADR 0087): the safety incidents and days without an
 * injury, the observations' closure, the corrective actions and the
 * drills, over the days asked (30 by default, a year at most).
 */
export default function SafetyKpisPage() {
  const { ready, can } = usePermissions();
  const allowed = can('incidents.manage') || can('guard_reports.read');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const report = useQuery({ queryKey: keys.safetyReport(period), queryFn: () => fetchers.safetyReport(period), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Safety KPIs" />
        <ForbiddenState />
      </>
    );
  const r = report.data;
  return (
    <>
      <PageHeader
        title="Safety KPIs"
        description={r ? `${formatDate(r.from)} – ${formatDate(r.to)}` : 'Incidents, observations, corrective actions and drills.'}
      />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <div className="grid grid--stats">
              <Stat label="Safety incidents" value={r.incidents.reported} />
              <Stat label="Injuries" value={r.incidents.injuries} />
              <Stat
                label="Days without an injury"
                value={r.incidents.daysWithoutInjury ?? '—'}
                hint={r.incidents.lastInjuryOn ? `Last on ${formatDate(r.incidents.lastInjuryOn)}` : 'None recorded'}
              />
              <Stat label="Observations closed" value={pct(r.observations.closureRatePct)} hint={`${r.observations.closed} of ${r.observations.reported}`} />
              <Stat label="Actions on time" value={pct(r.actions.onTimeRatePct)} hint={`${r.actions.overdueNow} overdue now`} />
              <Stat label="Drills held" value={r.drills.held} hint={`${r.drills.scheduled} scheduled`} />
            </div>
            <Card flush>
              <CardHeader title="In detail" />
              <CardBody>
                <dl className="dl">
                  <dt>Incidents</dt>
                  <dd>
                    {r.incidents.nearMisses} near misses · {r.incidents.hazards} hazards · {r.incidents.fires} fires ·{' '}
                    {r.incidents.propertyDamage} property damage
                  </dd>
                  <dt>Observations</dt>
                  <dd>
                    Average to a close: {r.observations.avgHoursToClose === null ? '—' : `${r.observations.avgHoursToClose} h`}
                  </dd>
                  <dt>Corrective actions</dt>
                  <dd>
                    {r.actions.opened} made · {r.actions.done} done ({r.actions.doneOnTime} on time) · {r.actions.cancelled} called off ·{' '}
                    {r.actions.openNow} open now
                  </dd>
                  <dt>Drills</dt>
                  <dd>
                    {r.drills.passed} passed · {r.drills.issuesFound} with issues · {r.drills.failed} failed · {r.drills.participants} took part
                    {r.drills.avgMinutes === null ? '' : ` · ${r.drills.avgMinutes} min on average`}
                  </dd>
                </dl>
              </CardBody>
            </Card>
          </>
        ) : null}
      </QueryState>
    </>
  );
}
