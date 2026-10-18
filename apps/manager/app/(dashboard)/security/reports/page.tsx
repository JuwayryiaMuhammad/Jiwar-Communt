'use client';

import { errorText, formatDateTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Alert, Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { minutesText, personName, postName, today } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DailyReport } from '@/lib/queries';

type Post = DailyReport['posts'][number];

/** The guards' daily report (ADR 0050), per gate and zone, as JSON and CSV. */
export default function SecurityReportsPage() {
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
  const [error, setError] = useState<string | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Daily security report" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Daily security report" description="Per gate and zone: shifts, lateness and absence, tasks, emergencies, gate services, visitors, patrols, and the incidents and violations of the guards on shift there." />
      <div className="toolbar">
        <Field label="Day">{(p) => <Input {...p} type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Gate">{(p) => <PostPicker {...p} gatesOnly placeholder="Every gate and zone" value={gate} onChange={(e) => setGate(e.target.value)} />}</Field>
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
          Export CSV
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <QueryState query={report}>
        <div className="stack">
          <Card flush>
            <DataTable<Post>
              rows={report.data?.posts}
              rowKey={(p) => p.post.gateId ?? p.post.zone?.id ?? ''}
              empty="No gate"
              columns={[
                { key: 'post', header: 'Post', cell: (p) => <span className="table__primary">{postName(p.post)}</span> },
                { key: 'shifts', header: 'Shifts', cell: (p) => <span className="t-num">{p.shifts.length}</span> },
                { key: 'slots', header: 'Slots filled', cell: (p) => <span className="t-num">{p.counts.filledSlots} / {p.counts.scheduledSlots}</span> },
                { key: 'late', header: 'Late', cell: (p) => <span className="t-num">{p.counts.late}</span> },
                { key: 'absent', header: 'Absent', cell: (p) => <span className="t-num">{p.counts.absent}</span> },
                { key: 'tasks', header: 'Tasks done / open', cell: (p) => <span className="t-num">{p.counts.tasksDone} / {p.counts.tasksOpen}</span> },
                { key: 'em', header: 'Emergencies', cell: (p) => <span className="t-num">{p.counts.emergencies}</span> },
                { key: 'gs', header: 'Gate services', cell: (p) => <span className="t-num">{p.counts.gateServices}</span> },
                { key: 'vis', header: 'Visitors', cell: (p) => <span className="t-num">{p.counts.visitors ?? '—'}</span> },
                {
                  key: 'patrols',
                  header: 'Patrols done / scheduled',
                  cell: (p) => (
                    <span className="t-num" title={`Late ${p.patrols.late} · missed ${p.patrols.missed} · incomplete ${p.patrols.incomplete}`}>
                      {p.patrols.done} / {p.patrols.scheduled}
                    </span>
                  ),
                },
                { key: 'pmissed', header: 'Missed / incomplete', cell: (p) => <span className="t-num">{p.patrols.missed} / {p.patrols.incomplete}</span> },
                { key: 'incidents', header: 'Incidents', cell: (p) => <span className="t-num">{p.counts.incidents}</span> },
                { key: 'violations', header: 'Violations', cell: (p) => <span className="t-num">{p.counts.violations}</span> },
              ]}
            />
          </Card>
          {(report.data?.posts ?? [])
            .filter((p) => p.shifts.length)
            .map((p) => (
              <Card key={p.post.gateId ?? p.post.zone?.id}>
                <CardHeader title={`${postName(p.post)} · shifts`} />
                <DataTable
                  rows={p.shifts}
                  rowKey={(s) => `${s.guard.id}-${s.startedAt}`}
                  empty="No shift"
                  columns={[
                    { key: 'guard', header: 'Guard', cell: (s) => personName(s.guard) },
                    { key: 'from', header: 'Started', cell: (s) => formatDateTime(s.startedAt) },
                    { key: 'to', header: 'Ended', cell: (s) => (s.endedAt ? formatDateTime(s.endedAt) : 'On shift') },
                    { key: 'late', header: 'Late', cell: (s) => (s.late ? `${s.lateMinutes} min` : s.scheduledStart ? 'On time' : 'Unscheduled') },
                    { key: 'ot', header: 'Overtime', cell: (s) => (s.unscheduledMinutes !== null ? `Unscheduled ${minutesText(s.unscheduledMinutes)}` : minutesText(s.overtimeMinutes)) },
                  ]}
                />
              </Card>
            ))}
        </div>
      </QueryState>
    </>
  );
}
