'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, CardBody, CardHeader, Field, ForbiddenState, Input, PageHeader, Stat, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/sec-safety';
import en from '@/messages/en/sec-safety';

/**
 * The safety KPIs (ADR 0087): the safety incidents and days without an
 * injury, the observations' closure, the corrective actions and the
 * drills, over the days asked (30 by default, a year at most).
 */
export default function SafetyKpisPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('incidents.manage') || can('guard_reports.read');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const report = useQuery({ queryKey: keys.safetyReport(period), queryFn: () => fetchers.safetyReport(period), enabled: allowed });
  const pct = (v: number | null) => (v === null ? '—' : `${f.number(v)}%`);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const r = report.data;
  return (
    <>
      <PageHeader title={t('title')} description={r ? `${f.day(r.from)} – ${f.day(r.to)}` : t('description')} />
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={report}>
        {r ? (
          <>
            <div className="grid grid--stats">
              <Stat label={t('safetyIncidents')} value={f.number(r.incidents.reported)} />
              <Stat label={t('injuries')} value={f.number(r.incidents.injuries)} />
              <Stat
                label={t('daysWithoutInjury')}
                value={r.incidents.daysWithoutInjury === null ? '—' : f.number(r.incidents.daysWithoutInjury)}
                hint={r.incidents.lastInjuryOn ? t('lastInjury', { date: f.day(r.incidents.lastInjuryOn) }) : t('noneRecorded')}
              />
              <Stat
                label={t('observationsClosed')}
                value={pct(r.observations.closureRatePct)}
                hint={t('closedOf', { closed: f.number(r.observations.closed), reported: f.number(r.observations.reported) })}
              />
              <Stat label={t('actionsOnTime')} value={pct(r.actions.onTimeRatePct)} hint={t('overdueNow', { n: f.number(r.actions.overdueNow) })} />
              <Stat label={t('drillsHeld')} value={f.number(r.drills.held)} hint={t('drillsScheduled', { n: f.number(r.drills.scheduled) })} />
            </div>
            <Card flush>
              <CardHeader title={t('inDetail')} />
              <CardBody>
                <dl className="dl">
                  <dt>{t('incidents')}</dt>
                  <dd>
                    {[
                      t('nearMisses', { n: r.incidents.nearMisses }),
                      t('hazards', { n: r.incidents.hazards }),
                      t('fires', { n: r.incidents.fires }),
                      t('propertyDamage', { n: f.number(r.incidents.propertyDamage) }),
                    ].join(' · ')}
                  </dd>
                  <dt>{t('observations')}</dt>
                  <dd>
                    {t('avgToClose', {
                      value: r.observations.avgHoursToClose === null ? '—' : t('hours', { n: f.number(r.observations.avgHoursToClose) }),
                    })}
                  </dd>
                  <dt>{t('correctiveActions')}</dt>
                  <dd>
                    {[
                      t('actionsMade', { n: f.number(r.actions.opened) }),
                      t('actionsDone', { n: f.number(r.actions.done), onTime: f.number(r.actions.doneOnTime) }),
                      t('actionsCalledOff', { n: f.number(r.actions.cancelled) }),
                      t('actionsOpen', { n: f.number(r.actions.openNow) }),
                    ].join(' · ')}
                  </dd>
                  <dt>{t('drills')}</dt>
                  <dd>
                    {[
                      t('drillsPassed', { n: f.number(r.drills.passed) }),
                      t('drillsIssues', { n: f.number(r.drills.issuesFound) }),
                      t('drillsFailed', { n: f.number(r.drills.failed) }),
                      t('drillsTookPart', { n: f.number(r.drills.participants) }),
                      ...(r.drills.avgMinutes === null ? [] : [t('drillsAvg', { n: f.number(r.drills.avgMinutes) })]),
                    ].join(' · ')}
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
