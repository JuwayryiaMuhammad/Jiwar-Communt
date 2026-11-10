'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT, type Format, type Translate } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Brief, type BriefKind, type BriefListItem } from '@/lib/queries';
import ar from '@/messages/ar/briefs';
import en from '@/messages/en/briefs';

type T = Translate<typeof en>;

/** One line per figure the reader may read of a brief; a section left out is not theirs. */
function figureLines(b: Brief, t: T, f: Format): [string, string][] {
  const g = b.figures;
  const n = (v: number) => f.number(v);
  const out: [string, string][] = [];
  if (g.maintenance) {
    const m = g.maintenance;
    out.push([t('fig.open'), t('fig.open.value', { open: n(m.open), unassigned: n(m.unassigned), onHold: n(m.onHold) })]);
    out.push([t('fig.today'), `${n(m.openedToday)} · ${n(m.completedToday)} · ${n(m.closedToday)}`]);
    out.push([t('fig.emergencies'), n(m.emergencyOpen)]);
    if (m.slaEnabled) out.push([t('fig.sla'), `${n(m.overdue)} · ${n(m.atRisk)}`]);
    out.push([t('fig.planned'), `${n(m.plannedDueToday)} · ${n(m.inspectionsDueToday)}`]);
    if (m.pressure.underPressure) out.push([t('fig.pressure'), t('fig.pressure.value', { open: n(m.open), available: n(m.pressure.available) })]);
  }
  if (g.energy) out.push([t('fig.outages'), `${n(g.energy.outagesActive)} · ${n(g.energy.outagesLaterToday)}`]);
  if (g.security)
    out.push([t('fig.incidents'), `${n(g.security.incidentsToday)} · ${n(g.security.incidentsOpen)} · ${n(g.security.lockdownsLive)}`]);
  if (g.gate) out.push([t('fig.gate'), `${n(g.gate.entriesToday)} · ${n(g.gate.visitorsToday)} · ${n(g.gate.exitsToday)}`]);
  if (g.finance) {
    out.push([t('fig.collected'), `${f.money(g.finance.collectedToday)} · ${f.money(g.finance.collectedMonth)}`]);
    out.push([t('fig.rate'), f.percent(g.finance.collectionRate, 1)]);
    out.push([t('fig.overdue'), t('fig.overdue.value', { amount: f.money(g.finance.overdueAmount), n: g.finance.overdueInvoices })]);
  }
  if (g.units) out.push([t('fig.units'), `${n(g.units.occupied)} · ${n(g.units.vacant)} · ${n(g.units.closed)}`]);
  return out;
}

function BriefDetail({ id }: { id: string }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const brief = useQuery({ queryKey: keys.brief(id), queryFn: () => fetchers.brief(id) });
  return (
    <QueryState query={brief}>
      {brief.data ? (
        <div className="stack">
          <span className="t-secondary">
            {t('head', {
              kind: t(`kind.${brief.data.kind}`),
              date: f.day(brief.data.date),
              when: f.dateTime(brief.data.generatedAt),
              zone: brief.data.timeZone,
            })}
          </span>
          <ul className="list">
            {figureLines(brief.data, t, f).map(([name, value]) => (
              <li key={name} className="list__item">
                <div className="list__text">
                  <div className="list__meta">{name}</div>
                  <div className="list__title">{value}</div>
                </div>
              </li>
            ))}
          </ul>
          {brief.data.inbox ? (
            <div className="stack stack--sm">
              <strong>{t('waiting', { total: f.number(brief.data.inbox.total), overdue: f.number(brief.data.inbox.overdue) })}</strong>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {brief.data.inbox.types
                  .filter((x) => x.total > 0)
                  .map((x) => (
                    <Badge key={x.type} tone={x.overdue ? 'terracotta' : 'beige'}>
                      {label(x.type)} {f.number(x.total)}
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
  const t = useT(en, ar);
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
    { invalidate: [keys.dashboardSettings], onDone: () => toast.show(t('times.saved')) },
  );
  const editable = can('settings.manage');
  return (
    <Card flush>
      <CardHeader title={t('times.title')} />
      <CardBody>
        <QueryState query={settings} rows={2}>
          <div className="stack">
            <p className="t-secondary">{t('times.intro', { zone: settings.data?.timeZone ?? '' })}</p>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Field label={t('kind.brief')} error={fieldError(save.error, 'briefAt')}>
                {(p) => <Input {...p} type="time" value={briefAt} disabled={!editable} onChange={(e) => setBriefAt(e.target.value)} />}
              </Field>
              <Field label={t('kind.review')} error={fieldError(save.error, 'reviewAt')}>
                {(p) => <Input {...p} type="time" value={reviewAt} disabled={!editable} onChange={(e) => setReviewAt(e.target.value)} />}
              </Field>
            </div>
            {editable ? (
              <span>
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  {t('times.save')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('dashboard.read');
  const [kind, setKind] = useState<BriefKind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.briefs(kind), (cursor) => fetchers.briefs(kind, cursor), { enabled: allowed });
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
        <Segmented<BriefKind | ''>
          label={c('kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: c('all') },
            { value: 'brief', label: t('filter.briefs') },
            { value: 'review', label: t('filter.reviews') },
          ]}
        />
      </div>
      <div className="grid grid--main-aside">
        <Card flush>
          <QueryState query={list}>
            <DataTable<BriefListItem>
              rows={list.rows}
              rowKey={(b) => b.id}
              empty={t('empty')}
              columns={[
                { key: 'date', header: t('day'), width: 120, cell: (b) => f.day(b.date) },
                {
                  key: 'kind',
                  header: c('kind'),
                  cell: (b) => (
                    <button type="button" className="table__link" onClick={() => setOpen(b.id)}>
                      {t(`kind.${b.kind}`)}
                    </button>
                  ),
                },
                { key: 'at', header: t('written'), cell: (b) => f.dateTime(b.generatedAt) },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
        <div className="stack">
          <Card flush>
            <CardHeader title={open ? t('figures') : t('pickOne')} />
            <CardBody>
              {open ? <BriefDetail id={open} /> : <EmptyState title={t('nothingOpen')}>{t('pickHint')}</EmptyState>}
            </CardBody>
          </Card>
          <Times />
        </div>
      </div>
    </>
  );
}
