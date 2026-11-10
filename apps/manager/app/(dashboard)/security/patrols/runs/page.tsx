'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { progressText } from '@/components/patrols/logic';
import { addDays, nameIn, personNameIn, postNameIn, today } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolRun, type PatrolRunDetail, type PatrolRunStatus } from '@/lib/queries';
import ar from '@/messages/ar/guard-runs';
import en from '@/messages/en/guard-runs';

const VIEWS = ['all', 'scheduled', 'in_progress', 'completed', 'incomplete', 'missed'] as const;
type View = (typeof VIEWS)[number];
type Stop = PatrolRunDetail['stops'][number];

function TrackCard({ id }: { id: string }) {
  const t = useT(en, ar);
  const f = useFormat();
  const track = useQuery({ queryKey: keys.runTrack(id), queryFn: () => fetchers.runTrack(id) });
  return (
    <Card>
      <CardHeader title={t('track')} />
      <QueryState query={track} rows={2}>
        {track.data?.data.length ? (
          <DataTable
            rows={track.data.data}
            rowKey={(p) => p.recordedAt}
            empty={t('noPoint')}
            columns={[
              { key: 'at', header: t('col.at'), cell: (p) => f.dateTime(p.recordedAt) },
              { key: 'where', header: t('col.position'), cell: (p) => <span className="ltr">{`${p.lat}, ${p.lng}`}</span> },
              { key: 'acc', header: t('col.accuracy'), cell: (p) => (p.accuracyM !== null ? t('accuracy', { m: f.number(Math.round(p.accuracyM)) }) : '—') },
            ]}
          />
        ) : (
          <p className="t-secondary">{t('noPointText')}</p>
        )}
      </QueryState>
    </Card>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const { can } = usePermissions();
  const run = useQuery({ queryKey: keys.run(id), queryFn: () => fetchers.run(id) });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/patrols/runs/{id}/cancel', {
          params: { path: { id } },
          body: { reasonCode: reasonCode as (typeof REASON_CODES.patrolRunCancel)[number] },
        }),
      ),
    {
      invalidate: [keys.runsAll],
      onDone: () => {
        toast.show(t('cancelled'));
        setCancelling(false);
      },
    },
  );
  const r = run.data;
  const manage = can('patrols.manage');
  return (
    <>
      <Dialog
        open={!cancelling}
        wide
        onClose={onClose}
        title={r ? `${nameIn(r.route, locale)} · ${f.dateTime(r.plannedAt)}` : t('run')}
        footer={
          <>
            {r?.status === 'scheduled' && manage ? <Button onClick={() => setCancelling(true)}>{t('cancelRun')}</Button> : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={run} rows={5}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.late ? <Badge tone="terracotta">{t('late')}</Badge> : null}
                  {r.endReason ? <span className="t-secondary"> · {label(r.endReason)}</span> : null}
                  {r.cancelReason ? <span className="t-secondary"> · {label(r.cancelReason)}</span> : null}
                </dd>
                <dt>{t('post')}</dt>
                <dd>{postNameIn(r.post, locale)}</dd>
                <dt>{t('guard')}</dt>
                <dd>{r.guard ? personNameIn(r.guard, locale) : '—'}</dd>
                <dt>{t('started')}</dt>
                <dd>{r.startedAt ? f.dateTime(r.startedAt) : '—'}</dd>
                <dt>{t('ended')}</dt>
                <dd>{r.endedAt ? f.dateTime(r.endedAt) : '—'}</dd>
                <dt>{t('scanned')}</dt>
                <dd>
                  <span className="ltr">{progressText(r)}</span>
                  {r.manualScans ? <span className="t-secondary"> · {t('byHand', { n: f.number(r.manualScans) })}</span> : null}
                  {r.suspectScans ? <span className="t-secondary"> · {t('farFromPoint', { n: f.number(r.suspectScans) })}</span> : null}
                  {r.lateScans ? <span className="t-secondary"> · {t('sentAfter', { n: f.number(r.lateScans) })}</span> : null}
                </dd>
              </dl>
              <DataTable<Stop>
                rows={r.stops}
                rowKey={(s) => s.checkpointId}
                empty={t('noCheckpoint')}
                columns={[
                  { key: 'n', header: '#', cell: (s) => <span className="t-num">{f.number(s.position)}</span> },
                  { key: 'name', header: t('col.checkpoint'), cell: (s) => nameIn(s, locale) },
                  {
                    key: 'scan',
                    header: t('col.scan'),
                    cell: (s) =>
                      s.scan ? (
                        <span className="row">
                          {f.dateTime(s.scan.scannedAt)}
                          {s.scan.method === 'manual' ? <Badge tone="beige">{t('byHandBadge', { reason: label(s.scan.manualReason) })}</Badge> : null}
                          {s.scan.positionSuspect ? <Badge tone="error">{t('metresAway', { m: s.scan.distanceM === null ? '?' : f.number(s.scan.distanceM) })}</Badge> : null}
                          {s.scan.late ? <Badge tone="terracotta">{t('sentLate')}</Badge> : null}
                        </span>
                      ) : (
                        <span className="t-secondary">{t('notScanned')}</span>
                      ),
                  },
                  {
                    key: 'note',
                    header: t('col.note'),
                    cell: (s) =>
                      s.note ? (
                        <span className="stack stack--sm">
                          <StatusBadge status={s.note.outcome} />
                          {s.note.text ? <span>{s.note.text}</span> : s.note.textCleared ? <span className="t-secondary">{t('noteErased')}</span> : null}
                          {s.note.photos.length ? (
                            <span className="row">
                              {s.note.photos.map((p, i) => (
                                <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                                  {t('photo', { n: f.number(i + 1) })}
                                </a>
                              ))}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
              {manage && r.startedAt ? <TrackCard id={r.id} /> : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelTitle')}
        codes={REASON_CODES.patrolRunCancel}
        confirmLabel={t('cancelRun')}
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}

/** Patrol runs (ADR 0052): planned on the days asked, what was scanned, what was found. */
export default function PatrolRunsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage') || can('guard_reports.read');
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const [view, setView] = useState<View>('all');
  const [open, setOpen] = useState<string | null>(null);
  const status: PatrolRunStatus | '' = view === 'all' ? '' : view;
  const filters = { from, to, status };
  const list = useCursorList(keys.runs(filters), (cursor) => fetchers.runs(filters, cursor), { enabled: allowed && from !== '' && to !== '' });
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
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PatrolRun>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'route',
                header: t('col.route'),
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r.id)}>
                    {nameIn(r.route, locale)}
                  </Button>
                ),
              },
              { key: 'post', header: t('col.post'), cell: (r) => postNameIn(r.post, locale) },
              { key: 'when', header: t('col.planned'), cell: (r) => f.dateTime(r.plannedAt) },
              {
                key: 'status',
                header: t('col.status'),
                cell: (r) => (
                  <span className="row">
                    <StatusBadge status={r.status} />
                    {r.late ? <Badge tone="terracotta">{t('late')}</Badge> : null}
                    {r.kind === 'adhoc' ? <Badge tone="beige">{t('unscheduled')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'guard', header: t('col.guard'), cell: (r) => (r.guard ? personNameIn(r.guard, locale) : '—') },
              { key: 'scanned', header: t('col.scanned'), cell: (r) => <span className="t-num ltr">{progressText(r)}</span> },
              {
                key: 'flags',
                header: '',
                cell: (r) => (
                  <span className="row">
                    {r.manualScans ? <Badge tone="beige">{t('byHand', { n: f.number(r.manualScans) })}</Badge> : null}
                    {r.suspectScans ? <Badge tone="error">{t('far', { n: f.number(r.suspectScans) })}</Badge> : null}
                    {r.lateScans ? <Badge tone="terracotta">{t('offline')}</Badge> : null}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <RunDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
