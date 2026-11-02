'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inboxLabel } from '@/components/inbox/inbox-types';
import { percent } from '@/components/operations/dashboard';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Brief, type BriefKind, type BriefListItem } from '@/lib/queries';

const KIND_LABEL: Record<BriefKind, string> = { brief: 'Daily brief', review: 'End-of-day review' };

/** One line per figure the reader may read of a brief; a section left out is not theirs. */
function figureLines(b: Brief): [string, string][] {
  const f = b.figures;
  const out: [string, string][] = [];
  if (f.maintenance) {
    const m = f.maintenance;
    out.push(['Open tickets', `${m.open} (${m.unassigned} unassigned, ${m.onHold} on hold)`]);
    out.push(['Opened · completed · closed today', `${m.openedToday} · ${m.completedToday} · ${m.closedToday}`]);
    out.push(['Emergencies open', String(m.emergencyOpen)]);
    if (m.slaEnabled) out.push(['Past the SLA · at risk', `${m.overdue} · ${m.atRisk}`]);
    out.push(['Planned work · inspections due today', `${m.plannedDueToday} · ${m.inspectionsDueToday}`]);
    if (m.pressure.underPressure) out.push(['Service pressure', `${m.open} open for ${m.pressure.available} available`]);
  }
  if (f.energy) out.push(['Outages in force · later today', `${f.energy.outagesActive} · ${f.energy.outagesLaterToday}`]);
  if (f.security)
    out.push(['Incidents today · open · lockdowns', `${f.security.incidentsToday} · ${f.security.incidentsOpen} · ${f.security.lockdownsLive}`]);
  if (f.gate) out.push(['Gate entries · visitors · exits', `${f.gate.entriesToday} · ${f.gate.visitorsToday} · ${f.gate.exitsToday}`]);
  if (f.finance) {
    out.push(['Collected today · this month', `${f.finance.collectedToday} · ${f.finance.collectedMonth} ${f.finance.currency}`]);
    out.push(['Paid of what is due this month', percent(f.finance.collectionRate)]);
    out.push(['Owed past its day', `${f.finance.overdueAmount} (${f.finance.overdueInvoices} invoices)`]);
  }
  if (f.units) out.push(['Units occupied · vacant · closed', `${f.units.occupied} · ${f.units.vacant} · ${f.units.closed}`]);
  return out;
}

function BriefDetail({ id }: { id: string }) {
  const brief = useQuery({ queryKey: keys.brief(id), queryFn: () => fetchers.brief(id) });
  return (
    <QueryState query={brief}>
      {brief.data ? (
        <div className="stack">
          <span className="t-secondary">
            {KIND_LABEL[brief.data.kind]} of {brief.data.date} · written {formatDateTime(brief.data.generatedAt)} (
            {brief.data.timeZone})
          </span>
          <ul className="list">
            {figureLines(brief.data).map(([label, value]) => (
              <li key={label} className="list__item">
                <div className="list__text">
                  <div className="list__meta">{label}</div>
                  <div className="list__title">{value}</div>
                </div>
              </li>
            ))}
          </ul>
          {brief.data.inbox ? (
            <div className="stack stack--sm">
              <strong>
                Waiting for a decision: {brief.data.inbox.total} ({brief.data.inbox.overdue} overdue)
              </strong>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {brief.data.inbox.types
                  .filter((t) => t.total > 0)
                  .map((t) => (
                    <Badge key={t.type} tone={t.overdue ? 'terracotta' : 'beige'}>
                      {inboxLabel(t.type)} {t.total}
                    </Badge>
                  ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
}

/** When the brief and the review are written (ADR 0079); the managers change it. */
function Times() {
  const toast = useToast();
  const { can } = usePermissions();
  const settings = useQuery({ queryKey: keys.dashboardSettings, queryFn: fetchers.dashboardSettings });
  const [briefAt, setBriefAt] = useState('');
  const [reviewAt, setReviewAt] = useState('');
  useEffect(() => {
    setBriefAt(settings.data?.briefAt ?? '');
    setReviewAt(settings.data?.reviewAt ?? '');
  }, [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/dashboard/settings', {
          body: { briefAt: briefAt || null, reviewAt: reviewAt || null },
        }),
      ),
    { invalidate: [keys.dashboardSettings], onDone: () => toast.show('The times are saved.') },
  );
  const editable = can('settings.manage');
  return (
    <Card flush>
      <CardHeader title="When they are written" />
      <CardBody>
        <QueryState query={settings} rows={2}>
          <div className="stack">
            <p className="t-secondary">
              In the compound’s time ({settings.data?.timeZone}), once a day each; empty for none. Everyone with the dashboard
              is told when one is ready.
            </p>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Field label="Daily brief" error={fieldError(save.error, 'briefAt')}>
                {(f) => <Input {...f} type="time" value={briefAt} disabled={!editable} onChange={(e) => setBriefAt(e.target.value)} />}
              </Field>
              <Field label="End-of-day review" error={fieldError(save.error, 'reviewAt')}>
                {(f) => <Input {...f} type="time" value={reviewAt} disabled={!editable} onChange={(e) => setReviewAt(e.target.value)} />}
              </Field>
            </div>
            {editable ? (
              <span>
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  Save times
                </Button>
              </span>
            ) : null}
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/** The daily briefs and the end-of-day reviews (ADR 0079), newest first. */
export default function BriefsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('dashboard.read');
  const [kind, setKind] = useState<BriefKind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.briefs(kind), (c) => fetchers.briefs(kind, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Daily briefs" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Daily briefs"
        description="The compound’s day in figures: the brief in the morning, the review at the end of it. Each shows the parts of the compound your role reads."
      />
      <div className="toolbar">
        <Segmented<BriefKind | ''>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: 'All' },
            { value: 'brief', label: 'Briefs' },
            { value: 'review', label: 'Reviews' },
          ]}
        />
      </div>
      <div className="grid grid--main-aside">
        <Card flush>
          <QueryState query={list}>
            <DataTable<BriefListItem>
              rows={list.rows}
              rowKey={(b) => b.id}
              empty="None written yet"
              columns={[
                { key: 'date', header: 'Day', width: 120, cell: (b) => b.date },
                {
                  key: 'kind',
                  header: 'Kind',
                  cell: (b) => (
                    <button type="button" className="table__link" onClick={() => setOpen(b.id)}>
                      {KIND_LABEL[b.kind]}
                    </button>
                  ),
                },
                { key: 'at', header: 'Written', cell: (b) => formatDateTime(b.generatedAt) },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
        <div className="stack">
          <Card flush>
            <CardHeader title={open ? 'The figures' : 'Pick one'} />
            <CardBody>
              {open ? <BriefDetail id={open} /> : <EmptyState title="Nothing open">Pick a brief or a review to read it.</EmptyState>}
            </CardBody>
          </Card>
          <Times />
        </div>
      </div>
    </>
  );
}
