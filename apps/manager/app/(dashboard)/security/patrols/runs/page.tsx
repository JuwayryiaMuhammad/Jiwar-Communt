'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { progressText } from '@/components/patrols/logic';
import { addDays, personName, postName, today } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolRun, type PatrolRunDetail, type PatrolRunStatus } from '@/lib/queries';

const VIEWS = ['all', 'scheduled', 'in_progress', 'completed', 'incomplete', 'missed'] as const;
type View = (typeof VIEWS)[number];
type Stop = PatrolRunDetail['stops'][number];

function TrackCard({ id }: { id: string }) {
  const track = useQuery({ queryKey: keys.runTrack(id), queryFn: () => fetchers.runTrack(id) });
  return (
    <Card>
      <CardHeader title="Where the guard walked" />
      <QueryState query={track} rows={2}>
        {track.data?.data.length ? (
          <DataTable
            rows={track.data.data}
            rowKey={(p) => p.recordedAt}
            empty="No point"
            columns={[
              { key: 'at', header: 'At', cell: (p) => formatDateTime(p.recordedAt) },
              { key: 'where', header: 'Position', cell: (p) => `${p.lat}, ${p.lng}` },
              { key: 'acc', header: 'Accuracy', cell: (p) => (p.accuracyM !== null ? `${Math.round(p.accuracyM)} m` : '—') },
            ]}
          />
        ) : (
          <p className="t-secondary">No point: none was sent, or they were deleted after 30 days.</p>
        )}
      </QueryState>
    </Card>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
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
        toast.show('Run cancelled.');
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
        title={r ? `${r.route.nameEn} · ${formatDateTime(r.plannedAt)}` : 'Patrol run'}
        footer={
          <>
            {r?.status === 'scheduled' && manage ? <Button onClick={() => setCancelling(true)}>Cancel run</Button> : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={run} rows={5}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.late ? <Badge tone="terracotta">Late</Badge> : null}
                  {r.endReason ? <span className="t-secondary"> · {humanize(r.endReason)}</span> : null}
                  {r.cancelReason ? <span className="t-secondary"> · {humanize(r.cancelReason)}</span> : null}
                </dd>
                <dt>Post</dt>
                <dd>{postName(r.post)}</dd>
                <dt>Guard</dt>
                <dd>{r.guard ? personName(r.guard) : '—'}</dd>
                <dt>Started</dt>
                <dd>{r.startedAt ? formatDateTime(r.startedAt) : '—'}</dd>
                <dt>Ended</dt>
                <dd>{r.endedAt ? formatDateTime(r.endedAt) : '—'}</dd>
                <dt>Scanned</dt>
                <dd>
                  {progressText(r)}
                  {r.manualScans ? <span className="t-secondary"> · {r.manualScans} by hand</span> : null}
                  {r.suspectScans ? <span className="t-secondary"> · {r.suspectScans} far from their point</span> : null}
                  {r.lateScans ? <span className="t-secondary"> · {r.lateScans} sent after it ended (offline)</span> : null}
                </dd>
              </dl>
              <DataTable<Stop>
                rows={r.stops}
                rowKey={(s) => s.checkpointId}
                empty="No checkpoint"
                columns={[
                  { key: 'n', header: '#', cell: (s) => <span className="t-num">{s.position}</span> },
                  { key: 'name', header: 'Checkpoint', cell: (s) => s.nameEn },
                  {
                    key: 'scan',
                    header: 'Scan',
                    cell: (s) =>
                      s.scan ? (
                        <span className="row">
                          {formatDateTime(s.scan.scannedAt)}
                          {s.scan.method === 'manual' ? <Badge tone="beige">By hand · {humanize(s.scan.manualReason ?? '')}</Badge> : null}
                          {s.scan.positionSuspect ? <Badge tone="error">{s.scan.distanceM ?? '?'} m away</Badge> : null}
                          {s.scan.late ? <Badge tone="terracotta">Sent late</Badge> : null}
                        </span>
                      ) : (
                        <span className="t-secondary">Not scanned</span>
                      ),
                  },
                  {
                    key: 'note',
                    header: 'Note',
                    cell: (s) =>
                      s.note ? (
                        <span className="stack stack--sm">
                          <StatusBadge status={s.note.outcome} />
                          {s.note.text ? <span>{s.note.text}</span> : s.note.textCleared ? <span className="t-secondary">Erased with its guard</span> : null}
                          {s.note.photos.length ? (
                            <span className="row">
                              {s.note.photos.map((p, i) => (
                                <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                                  Photo {i + 1}
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
        title="Cancel this run?"
        codes={REASON_CODES.patrolRunCancel}
        confirmLabel="Cancel run"
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}

/** Patrol runs (ADR 0052): planned on the days asked, what was scanned, what was found. */
export default function PatrolRunsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage') || can('guard_reports.read');
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const [view, setView] = useState<View>('all');
  const [open, setOpen] = useState<string | null>(null);
  const status: PatrolRunStatus | '' = view === 'all' ? '' : view;
  const filters = { from, to, status };
  const list = useCursorList(keys.runs(filters), (c) => fetchers.runs(filters, c), { enabled: allowed && from !== '' && to !== '' });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Patrol runs" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Patrol runs" description="Late, missed and incomplete runs are told to the roster’s keepers as they happen." />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Segmented<View>
          label="Runs shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All' },
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'in_progress', label: 'Under way' },
            { value: 'completed', label: 'Completed' },
            { value: 'incomplete', label: 'Incomplete' },
            { value: 'missed', label: 'Missed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PatrolRun>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No run"
            columns={[
              {
                key: 'route',
                header: 'Route',
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r.id)}>
                    {r.route.nameEn}
                  </Button>
                ),
              },
              { key: 'post', header: 'Post', cell: (r) => postName(r.post) },
              { key: 'when', header: 'Planned', cell: (r) => formatDateTime(r.plannedAt) },
              {
                key: 'status',
                header: 'Status',
                cell: (r) => (
                  <span className="row">
                    <StatusBadge status={r.status} />
                    {r.late ? <Badge tone="terracotta">Late</Badge> : null}
                    {r.kind === 'adhoc' ? <Badge tone="beige">Unscheduled</Badge> : null}
                  </span>
                ),
              },
              { key: 'guard', header: 'Guard', cell: (r) => (r.guard ? personName(r.guard) : '—') },
              { key: 'scanned', header: 'Scanned', cell: (r) => <span className="t-num">{progressText(r)}</span> },
              {
                key: 'flags',
                header: '',
                cell: (r) => (
                  <span className="row">
                    {r.manualScans ? <Badge tone="beige">{r.manualScans} by hand</Badge> : null}
                    {r.suspectScans ? <Badge tone="error">{r.suspectScans} far</Badge> : null}
                    {r.lateScans ? <Badge tone="terracotta">Offline</Badge> : null}
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
