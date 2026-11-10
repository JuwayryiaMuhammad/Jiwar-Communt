'use client';

import { useErrorText } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { minutesText, personNameIn, postNameIn, today } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DailyReport } from '@/lib/queries';
import ar from '@/messages/ar/sec-reports';
import en from '@/messages/en/sec-reports';

type Post = DailyReport['posts'][number];

/** The guards' daily report (ADR 0050), per gate and zone, as JSON and CSV. */
export default function SecurityReportsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('guard_reports.read');
  const [date, setDate] = useState(today());
  const [gate, setGate] = useState('');
  const gateId = gate.startsWith('gate:') ? gate.slice(5) : '';
  const report = useQuery({
    queryKey: keys.dailyReport(date, gateId),
    queryFn: () => fetchers.dailyReport(date, gateId),
    enabled: allowed && date !== '',
  });
  const [busy, setBusy] = useState(false);
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const n = (value: number) => <span className="t-num">{f.number(value)}</span>;
  const pair = (a: number, b: number) => (
    <span className="t-num">
      {f.number(a)} / {f.number(b)}
    </span>
  );
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
      <div className="toolbar">
        <Field label={t('day')}>{(p) => <Input {...p} type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label={t('gate')}>
          {(p) => <PostPicker {...p} gatesOnly placeholder={t('everyPost')} value={gate} onChange={(e) => setGate(e.target.value)} />}
        </Field>
        <Button
          icon={<Download aria-hidden />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await download('/api/v1/staff/security/reports/daily/export', { date, gateId: gateId || undefined }, `security-daily-${date}.csv`);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('exportCsv')}
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <QueryState query={report}>
        <div className="stack">
          <Card flush>
            <DataTable<Post>
              rows={report.data?.posts}
              rowKey={(p) => p.post.gateId ?? p.post.zone?.id ?? ''}
              empty={t('empty')}
              columns={[
                { key: 'post', header: t('col.post'), cell: (p) => <span className="table__primary">{postNameIn(p.post, locale)}</span> },
                { key: 'shifts', header: t('col.shifts'), cell: (p) => n(p.shifts.length) },
                { key: 'slots', header: t('col.slots'), cell: (p) => pair(p.counts.filledSlots, p.counts.scheduledSlots) },
                { key: 'late', header: t('col.late'), cell: (p) => n(p.counts.late) },
                { key: 'absent', header: t('col.absent'), cell: (p) => n(p.counts.absent) },
                { key: 'tasks', header: t('col.tasks'), cell: (p) => pair(p.counts.tasksDone, p.counts.tasksOpen) },
                { key: 'em', header: t('col.emergencies'), cell: (p) => n(p.counts.emergencies) },
                { key: 'gs', header: t('col.services'), cell: (p) => n(p.counts.gateServices) },
                { key: 'vis', header: t('col.visitors'), cell: (p) => (p.counts.visitors === null ? <span className="t-num">—</span> : n(p.counts.visitors)) },
                {
                  key: 'patrols',
                  header: t('col.patrols'),
                  cell: (p) => (
                    <span
                      className="t-num"
                      title={t('patrolsTitle', { late: f.number(p.patrols.late), missed: f.number(p.patrols.missed), incomplete: f.number(p.patrols.incomplete) })}
                    >
                      {f.number(p.patrols.done)} / {f.number(p.patrols.scheduled)}
                    </span>
                  ),
                },
                { key: 'pmissed', header: t('col.missed'), cell: (p) => pair(p.patrols.missed, p.patrols.incomplete) },
                { key: 'incidents', header: t('col.incidents'), cell: (p) => n(p.counts.incidents) },
                { key: 'violations', header: t('col.violations'), cell: (p) => n(p.counts.violations) },
              ]}
            />
          </Card>
          {(report.data?.posts ?? [])
            .filter((p) => p.shifts.length)
            .map((p) => (
              <Card key={p.post.gateId ?? p.post.zone?.id}>
                <CardHeader title={t('shiftsTitle', { post: postNameIn(p.post, locale) })} />
                <DataTable
                  rows={p.shifts}
                  rowKey={(s) => `${s.guard.id}-${s.startedAt}`}
                  empty={t('emptyShifts')}
                  columns={[
                    { key: 'guard', header: t('shift.guard'), cell: (s) => personNameIn(s.guard, locale) },
                    { key: 'from', header: t('shift.started'), cell: (s) => f.dateTime(s.startedAt) },
                    { key: 'to', header: t('shift.ended'), cell: (s) => (s.endedAt ? f.dateTime(s.endedAt) : t('onShift')) },
                    {
                      key: 'late',
                      header: t('shift.late'),
                      cell: (s) => (s.late ? minutesText(s.lateMinutes, locale) : s.scheduledStart ? t('onTime') : t('unscheduled')),
                    },
                    {
                      key: 'ot',
                      header: t('shift.overtime'),
                      cell: (s) =>
                        s.unscheduledMinutes !== null
                          ? t('unscheduledMinutes', { time: minutesText(s.unscheduledMinutes, locale) })
                          : minutesText(s.overtimeMinutes, locale),
                    },
                  ]}
                />
              </Card>
            ))}
        </div>
      </QueryState>
    </>
  );
}
