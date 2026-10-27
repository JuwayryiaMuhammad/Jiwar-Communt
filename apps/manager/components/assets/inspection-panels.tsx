'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, DataTable, Dialog, Field, Input, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { TechnicianPicker } from '@/components/maintenance/technician-picker';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { fetchers, keys, type InspectionRound, type InspectionSummary } from '@/lib/queries';
import { rateText, seriesText } from './format';

type Status = InspectionSummary['status'] | '';

/** Where and what with: the area or asset, the checklist, the inspector. */
function TargetFields({
  f,
  set,
  error,
}: {
  f: { place: string; checklistId: string; assigneeId: string };
  set: (k: 'place' | 'checklistId' | 'assigneeId') => (e: { target: { value: string } }) => void;
  error: unknown;
}) {
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const checklists = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  return (
    <div className="form__row">
      <Field label="Area" error={fieldError(error, 'commonAreaId')}>
        {(p) => (
          <Select {...p} value={f.place} onChange={set('place')}>
            <option value="">Select…</option>
            {(areas.data?.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.nameEn}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Checklist" error={fieldError(error, 'checklistId')}>
        {(p) => (
          <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
            <option value="">Select…</option>
            {(checklists.data?.data ?? [])
              .filter((c) => c.active && c.purpose !== 'pm')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameEn}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <Field label="Inspector" error={fieldError(error, 'assigneeId')}>
        {(p) => <TechnicianPicker {...p} value={f.assigneeId} onChange={set('assigneeId')} />}
      </Field>
    </div>
  );
}

function NewInspectionDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ place: '', checklistId: '', assigneeId: '', dueOn: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/inspections', {
          body: { commonAreaId: f.place, checklistId: f.checklistId, assigneeId: f.assigneeId, dueOn: f.dueOn },
        }),
      ),
    {
      invalidate: [keys.inspectionsAll],
      onDone: () => {
        toast.show('Scheduled; the inspector is told.');
        onClose();
      },
    },
  );
  const ready = f.place && f.checklistId && f.assigneeId && f.dueOn;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Schedule an inspection"
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="form">
        <TargetFields f={f} set={set} error={save.error} />
        <Field label="Due" error={fieldError(save.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={f.dueOn} onChange={set('dueOn')} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function NewRoundDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ place: '', checklistId: '', assigneeId: '', title: '', every: '1', unit: 'week', anchorOn: '', leadDays: '2' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/inspection-rounds', {
          body: {
            title: f.title.trim(),
            commonAreaId: f.place,
            checklistId: f.checklistId,
            assigneeId: f.assigneeId,
            every: Number(f.every),
            unit: f.unit as 'day' | 'week' | 'month' | 'year',
            anchorOn: f.anchorOn,
            leadDays: Number(f.leadDays),
          },
        }),
      ),
    {
      invalidate: [keys.inspectionsAll],
      onDone: () => {
        toast.show('The round is on.');
        onClose();
      },
    },
  );
  const ready = f.title.trim() && f.place && f.checklistId && f.assigneeId && f.anchorOn;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New inspection round"
      description="An inspection that comes back on the calendar: each due date opens one, a few days before, for its inspector."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add round
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Title" error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <TargetFields f={f} set={set} error={save.error} />
        <div className="form__row">
          <Field label="Every" error={fieldError(save.error, 'every')}>
            {(p) => <Input {...p} type="number" min={1} max={365} value={f.every} onChange={set('every')} />}
          </Field>
          <Field label="Unit">
            {(p) => (
              <Select {...p} value={f.unit} onChange={set('unit')}>
                {['day', 'week', 'month', 'year'].map((u) => (
                  <option key={u} value={u}>
                    {u}s
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="From" error={fieldError(save.error, 'anchorOn')}>
            {(p) => <Input {...p} type="date" value={f.anchorOn} onChange={set('anchorOn')} />}
          </Field>
          <Field label="Opens days before" error={fieldError(save.error, 'leadDays')}>
            {(p) => <Input {...p} type="number" min={0} max={60} value={f.leadDays} onChange={set('leadDays')} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

export function InspectionsPanel() {
  const [status, setStatus] = useState<Status>('scheduled');
  const [open, setOpen] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.inspections(filters), (c) => fetchers.inspections(filters, c));
  return (
    <>
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'submitted', label: 'Submitted' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: '', label: 'All' },
          ]}
        />
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
          Schedule
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<InspectionSummary>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No inspection"
            columns={[
              {
                key: 'd',
                header: 'Due',
                cell: (i) => (
                  <Link className="table__link" href={`/inspections/${i.id}`}>
                    {formatDate(i.dueOn)}
                  </Link>
                ),
              },
              { key: 's', header: 'Status', cell: (i) => humanize(i.status) },
              { key: 'r', header: 'From', cell: (i) => (i.roundId ? 'A round' : 'On its own') },
              { key: 'c', header: 'Scanned', cell: (i) => (i.scannedAt ? 'Yes' : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <NewInspectionDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function RoundsPanel() {
  const toast = useToast();
  const rounds = useQuery({ queryKey: keys.inspectionRounds({}), queryFn: () => fetchers.inspectionRounds({}) });
  const [open, setOpen] = useState(false);
  const toggle = useAction(
    (r: InspectionRound) =>
      unwrap(
        r.active
          ? api.POST('/api/v1/maintenance/inspection-rounds/{id}/deactivate', { params: { path: { id: r.id } } })
          : api.POST('/api/v1/maintenance/inspection-rounds/{id}/reactivate', { params: { path: { id: r.id } } }),
      ),
    { invalidate: [keys.inspectionsAll], onDone: (r) => toast.show(r.active ? 'The round is on.' : 'The round is off.') },
  );
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
          New round
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={rounds}>
          <DataTable<InspectionRound>
            rows={rounds.data?.data}
            rowKey={(r) => r.id}
            empty="No round"
            columns={[
              { key: 't', header: 'Round', cell: (r) => <span className="table__primary">{r.title}</span> },
              { key: 'e', header: 'How often', cell: (r) => seriesText(r) },
              { key: 'n', header: 'Next due', cell: (r) => formatDate(r.nextDueOn) },
              { key: 'a', header: 'Status', cell: (r) => (r.active ? 'On' : <Badge tone="beige">Off</Badge>) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(r)}>
                    {r.active ? 'Turn off' : 'Turn on'}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <NewRoundDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportPanel() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const report = useQuery({ queryKey: keys.inspectionReport(from, to), queryFn: () => fetchers.inspectionReport(from, to) });
  const t = report.data?.totals;
  return (
    <>
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <span className="spacer" />
        <Button
          icon={<Download aria-hidden />}
          onClick={() => void download('/api/v1/maintenance/inspection-report/export', { from, to }, `inspections-${from}-${to}.csv`)}
        >
          CSV
        </Button>
      </div>
      <QueryState query={report}>
        {t ? (
          <Card>
            <CardBody>
              <dl className="dl">
                <dt>Due in the period</dt>
                <dd>{t.inspections}</dd>
                <dt>Submitted</dt>
                <dd>
                  {t.submitted} · on time {rateText(t.submitted ? t.onTime / t.submitted : null)}
                </dd>
                <dt>Open</dt>
                <dd>
                  {t.open}
                  {t.overdue ? <Badge tone="error">{t.overdue} overdue</Badge> : null}
                </dd>
                <dt>Cancelled</dt>
                <dd>{t.cancelled}</dd>
                <dt>Failed items</dt>
                <dd>{t.failedItems}</dd>
                <dt>Findings followed up</dt>
                <dd>
                  {t.findingsClosed} of {t.findings} · {rateText(t.closureRate)}
                </dd>
              </dl>
            </CardBody>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
