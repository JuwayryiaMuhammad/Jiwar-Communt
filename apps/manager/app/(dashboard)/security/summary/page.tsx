'use client';

import { errorText, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Alert, Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { addDays, today } from '@/components/security/logic';
import { hoursText } from '@/components/security/ops-logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type IncidentReport, type ViolationReport } from '@/lib/queries';

type IncidentRow = Omit<IncidentReport['types'][number], 'type'> & { type: string; label: string };
type ViolationRow = Omit<ViolationReport['kinds'][number], 'kind'> & { kind: string; label: string };

const n = (v: number) => <span className="t-num">{v}</span>;

function Export({ path, period, name }: { path: string; period: { from: string; to: string }; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        icon={<Download aria-hidden />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await download(path, period, name);
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Export CSV
      </Button>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </>
  );
}

/**
 * The incidents and violations reports (ADR 0053): counts per type and per
 * kind over a period of the compound's days, 31 at most; each part shown
 * to whoever may read it, with its CSV.
 */
export default function SecuritySummaryPage() {
  const { ready, can } = usePermissions();
  const incidentsAllowed = can('incidents.manage') || can('guard_reports.read');
  const violationsAllowed = can('violations.manage') || can('guard_reports.read');
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const period = { from, to };
  const enabled = from !== '' && to !== '';
  const incidents = useQuery({
    queryKey: keys.incidentReport(period),
    queryFn: () => fetchers.incidentReport(period),
    enabled: incidentsAllowed && enabled,
  });
  const violations = useQuery({
    queryKey: keys.violationReport(period),
    queryFn: () => fetchers.violationReport(period),
    enabled: violationsAllowed && enabled,
  });
  if (ready && !incidentsAllowed && !violationsAllowed)
    return (
      <>
        <PageHeader title="Incidents and violations" />
        <ForbiddenState />
      </>
    );
  const incidentRows: IncidentRow[] = incidents.data
    ? [...incidents.data.types.map((t) => ({ ...t, label: humanize(t.type) })), { ...incidents.data.totals, type: 'all', label: 'All types' }]
    : [];
  const violationRows: ViolationRow[] = violations.data
    ? [...violations.data.kinds.map((k) => ({ ...k, label: humanize(k.kind) })), { ...violations.data.totals, kind: 'all', label: 'All kinds' }]
    : [];
  return (
    <>
      <PageHeader title="Incidents and violations" description="Counts only, never a name or a unit: 31 days at most. The daily report counts each post’s too." />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <div className="stack">
        {incidentsAllowed ? (
          <Card flush>
            <CardHeader
              title="Incidents, by when they happened"
              actions={<Export path="/api/v1/staff/security/reports/incidents/export" period={period} name={`security-incidents-${from}-${to}.csv`} />}
            />
            <QueryState query={incidents}>
              <DataTable<IncidentRow>
                rows={incidentRows}
                rowKey={(r) => r.type}
                empty="No incident"
                columns={[
                  { key: 'type', header: 'Type', cell: (r) => <span className={r.type === 'all' ? 'table__primary' : undefined}>{r.label}</span> },
                  { key: 'reported', header: 'Reported', cell: (r) => n(r.reported) },
                  { key: 'guards', header: 'By guards', cell: (r) => n(r.byGuards) },
                  { key: 'low', header: 'Low', cell: (r) => n(r.low) },
                  { key: 'medium', header: 'Medium', cell: (r) => n(r.medium) },
                  { key: 'high', header: 'High', cell: (r) => n(r.high) },
                  { key: 'critical', header: 'Critical', cell: (r) => n(r.critical) },
                  { key: 'open', header: 'Open', cell: (r) => n(r.open) },
                  { key: 'inv', header: 'Investigating', cell: (r) => n(r.investigating) },
                  { key: 'closed', header: 'Closed', cell: (r) => n(r.closed) },
                  { key: 'hours', header: 'Hours to close', cell: (r) => hoursText(r.avgHoursToClose) },
                ]}
              />
            </QueryState>
          </Card>
        ) : null}
        {violationsAllowed ? (
          <Card flush>
            <CardHeader
              title="Violations, by their day"
              actions={<Export path="/api/v1/staff/security/reports/violations/export" period={period} name={`security-violations-${from}-${to}.csv`} />}
            />
            <QueryState query={violations}>
              <DataTable<ViolationRow>
                rows={violationRows}
                rowKey={(r) => r.kind}
                empty="No violation"
                columns={[
                  { key: 'kind', header: 'Kind', cell: (r) => <span className={r.kind === 'all' ? 'table__primary' : undefined}>{r.label}</span> },
                  { key: 'issued', header: 'Issued', cell: (r) => n(r.issued) },
                  { key: 'guards', header: 'By guards', cell: (r) => n(r.byGuards) },
                  { key: 'warnings', header: 'Warnings', cell: (r) => n(r.warnings) },
                  { key: 'amount', header: 'Amount issued', cell: (r) => egp(r.amountIssued) },
                  { key: 'open', header: 'Open', cell: (r) => n(r.open) },
                  { key: 'appeal', header: 'Under appeal', cell: (r) => n(r.underAppeal) },
                  { key: 'paid', header: 'Paid', cell: (r) => n(r.paid) },
                  { key: 'paidAmount', header: 'Amount paid', cell: (r) => egp(r.amountPaid) },
                  { key: 'cancelled', header: 'Cancelled', cell: (r) => n(r.cancelled) },
                  { key: 'appeals', header: 'Appeals upheld / accepted', cell: (r) => <span className="t-num">{r.appealsUpheld} / {r.appealsAccepted}</span> },
                ]}
              />
            </QueryState>
          </Card>
        ) : null}
      </div>
    </>
  );
}
