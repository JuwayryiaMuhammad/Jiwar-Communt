'use client';

import { useErrorText } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { addDays, today } from '@/components/security/logic';
import { hoursTextIn } from '@/components/security/ops-logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type IncidentReport, type ViolationReport } from '@/lib/queries';
import ar from '@/messages/ar/sec-summary';
import en from '@/messages/en/sec-summary';

type IncidentRow = Omit<IncidentReport['types'][number], 'type'> & { type: string; label: string };
type ViolationRow = Omit<ViolationReport['kinds'][number], 'kind'> & { kind: string; label: string };

function Export({ path, period, name }: { path: string; period: { from: string; to: string }; name: string }) {
  const t = useT(en, ar);
  const [busy, setBusy] = useState(false);
  const errorText = useErrorText();
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
        {t('exportCsv')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
  const n = (v: number) => <span className="t-num">{f.number(v)}</span>;
  if (ready && !incidentsAllowed && !violationsAllowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const incidentRows: IncidentRow[] = incidents.data
    ? [...incidents.data.types.map((x) => ({ ...x, label: label(x.type) })), { ...incidents.data.totals, type: 'all', label: t('allTypes') }]
    : [];
  const violationRows: ViolationRow[] = violations.data
    ? [...violations.data.kinds.map((k) => ({ ...k, label: label(k.kind) })), { ...violations.data.totals, kind: 'all', label: t('allKinds') }]
    : [];
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <div className="stack">
        {incidentsAllowed ? (
          <Card flush>
            <CardHeader
              title={t('incidentsTitle')}
              actions={<Export path="/api/v1/staff/security/reports/incidents/export" period={period} name={`security-incidents-${from}-${to}.csv`} />}
            />
            <QueryState query={incidents}>
              <DataTable<IncidentRow>
                rows={incidentRows}
                rowKey={(r) => r.type}
                empty={t('emptyIncidents')}
                columns={[
                  { key: 'type', header: t('inc.type'), cell: (r) => <span className={r.type === 'all' ? 'table__primary' : undefined}>{r.label}</span> },
                  { key: 'reported', header: t('inc.reported'), cell: (r) => n(r.reported) },
                  { key: 'guards', header: t('inc.byGuards'), cell: (r) => n(r.byGuards) },
                  { key: 'low', header: t('inc.low'), cell: (r) => n(r.low) },
                  { key: 'medium', header: t('inc.medium'), cell: (r) => n(r.medium) },
                  { key: 'high', header: t('inc.high'), cell: (r) => n(r.high) },
                  { key: 'critical', header: t('inc.critical'), cell: (r) => n(r.critical) },
                  { key: 'open', header: t('inc.open'), cell: (r) => n(r.open) },
                  { key: 'inv', header: t('inc.investigating'), cell: (r) => n(r.investigating) },
                  { key: 'closed', header: t('inc.closed'), cell: (r) => n(r.closed) },
                  { key: 'hours', header: t('inc.hours'), cell: (r) => hoursTextIn(r.avgHoursToClose, locale) },
                ]}
              />
            </QueryState>
          </Card>
        ) : null}
        {violationsAllowed ? (
          <Card flush>
            <CardHeader
              title={t('violationsTitle')}
              actions={<Export path="/api/v1/staff/security/reports/violations/export" period={period} name={`security-violations-${from}-${to}.csv`} />}
            />
            <QueryState query={violations}>
              <DataTable<ViolationRow>
                rows={violationRows}
                rowKey={(r) => r.kind}
                empty={t('emptyViolations')}
                columns={[
                  { key: 'kind', header: t('vio.kind'), cell: (r) => <span className={r.kind === 'all' ? 'table__primary' : undefined}>{r.label}</span> },
                  { key: 'issued', header: t('vio.issued'), cell: (r) => n(r.issued) },
                  { key: 'guards', header: t('vio.byGuards'), cell: (r) => n(r.byGuards) },
                  { key: 'warnings', header: t('vio.warnings'), cell: (r) => n(r.warnings) },
                  { key: 'amount', header: t('vio.amountIssued'), cell: (r) => f.money(r.amountIssued) },
                  { key: 'open', header: t('vio.open'), cell: (r) => n(r.open) },
                  { key: 'appeal', header: t('vio.underAppeal'), cell: (r) => n(r.underAppeal) },
                  { key: 'paid', header: t('vio.paid'), cell: (r) => n(r.paid) },
                  { key: 'paidAmount', header: t('vio.amountPaid'), cell: (r) => f.money(r.amountPaid) },
                  { key: 'cancelled', header: t('vio.cancelled'), cell: (r) => n(r.cancelled) },
                  {
                    key: 'appeals',
                    header: t('vio.appeals'),
                    cell: (r) => (
                      <span className="t-num">
                        {f.number(r.appealsUpheld)} / {f.number(r.appealsAccepted)}
                      </span>
                    ),
                  },
                ]}
              />
            </QueryState>
          </Card>
        ) : null}
      </div>
    </>
  );
}
