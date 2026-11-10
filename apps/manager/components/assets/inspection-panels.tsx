'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, DataTable, Dialog, Field, Input, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { TechnicianPicker } from '@/components/maintenance/technician-picker';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { fetchers, keys, type InspectionRound, type InspectionSummary } from '@/lib/queries';
import formatAr from '@/messages/ar/assets-format';
import ar from '@/messages/ar/assets-inspections';
import formatEn from '@/messages/en/assets-format';
import en from '@/messages/en/assets-inspections';
import { nameOf, seriesText } from './format';

type Status = InspectionSummary['status'] | '';
const VIEWS = ['scheduled', 'in_progress', 'submitted', 'cancelled', 'all'] as const;
const UNITS = ['day', 'week', 'month', 'year'] as const;

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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const checklists = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  return (
    <div className="form__row">
      <Field label={t('area')} error={fieldError(error, 'commonAreaId')}>
        {(p) => (
          <Select {...p} value={f.place} onChange={set('place')}>
            <option value="">{c('select')}</option>
            {(areas.data?.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {nameOf(fmt.locale, a)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('checklist')} error={fieldError(error, 'checklistId')}>
        {(p) => (
          <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
            <option value="">{c('select')}</option>
            {(checklists.data?.data ?? [])
              .filter((x) => x.active && x.purpose !== 'pm')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {nameOf(fmt.locale, x)}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <Field label={t('inspector')} error={fieldError(error, 'assigneeId')}>
        {(p) => <TechnicianPicker {...p} value={f.assigneeId} onChange={set('assigneeId')} />}
      </Field>
    </div>
  );
}

function NewInspectionDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('scheduled'));
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
      title={t('scheduleTitle')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('schedule')}
          </Button>
        </>
      }
    >
      <div className="form">
        <TargetFields f={f} set={set} error={save.error} />
        <Field label={t('due')} error={fieldError(save.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={f.dueOn} onChange={set('dueOn')} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function NewRoundDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('roundOn'));
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
      title={t('roundTitle')}
      description={t('roundDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('addRound')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('roundName')} error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <TargetFields f={f} set={set} error={save.error} />
        <div className="form__row">
          <Field label={t('every')} error={fieldError(save.error, 'every')}>
            {(p) => <Input {...p} type="number" min={1} max={365} value={f.every} onChange={set('every')} />}
          </Field>
          <Field label={t('unit')}>
            {(p) => (
              <Select {...p} value={f.unit} onChange={set('unit')}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`unit.${u}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('from')} error={fieldError(save.error, 'anchorOn')}>
            {(p) => <Input {...p} type="date" value={f.anchorOn} onChange={set('anchorOn')} />}
          </Field>
          <Field label={t('leadDays')} error={fieldError(save.error, 'leadDays')}>
            {(p) => <Input {...p} type="number" min={0} max={60} value={f.leadDays} onChange={set('leadDays')} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

export function InspectionsPanel() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const [status, setStatus] = useState<Status>('scheduled');
  const [open, setOpen] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.inspections(filters), (c) => fetchers.inspections(filters, c));
  return (
    <>
      <div className="toolbar">
        <Segmented<Status>
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v === 'all' ? '' : v, label: t(`view.${v}`) }))}
        />
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
          {t('schedule')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<InspectionSummary>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              {
                key: 'd',
                header: t('col.due'),
                cell: (i) => (
                  <Link className="table__link" href={`/inspections/${i.id}`}>
                    {fmt.day(i.dueOn)}
                  </Link>
                ),
              },
              { key: 's', header: t('col.status'), cell: (i) => label(i.status) },
              { key: 'r', header: t('col.from'), cell: (i) => (i.roundId ? t('fromRound') : t('onItsOwn')) },
              { key: 'c', header: t('col.scanned'), cell: (i) => (i.scannedAt ? t('yes') : '—') },
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
  const t = useT(en, ar);
  const tf = useT(formatEn, formatAr);
  const fmt = useFormat();
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
    { invalidate: [keys.inspectionsAll], onDone: (r) => toast.show(r.active ? t('roundOn') : t('roundOff')) },
  );
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
          {t('newRound')}
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={rounds}>
          <DataTable<InspectionRound>
            rows={rounds.data?.data}
            rowKey={(r) => r.id}
            empty={t('noRound')}
            columns={[
              { key: 't', header: t('col.round'), cell: (r) => <span className="table__primary">{r.title}</span> },
              { key: 'e', header: t('col.often'), cell: (r) => seriesText(tf, r) },
              { key: 'n', header: t('col.nextDue'), cell: (r) => fmt.day(r.nextDueOn) },
              { key: 'a', header: t('col.status'), cell: (r) => (r.active ? t('on') : <Badge tone="beige">{t('off')}</Badge>) },
              {
                key: 'x',
                header: <span className="visually-hidden">{t('actions')}</span>,
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(r)}>
                    {r.active ? t('turnOff') : t('turnOn')}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const report = useQuery({ queryKey: keys.inspectionReport(from, to), queryFn: () => fetchers.inspectionReport(from, to) });
  const r = report.data?.totals;
  const rate = (x: number | null) => fmt.percent(x, 0);
  return (
    <>
      <div className="toolbar">
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <span className="spacer" />
        <Button
          icon={<Download aria-hidden />}
          onClick={() => void download('/api/v1/maintenance/inspection-report/export', { from, to }, `inspections-${from}-${to}.csv`)}
        >
          CSV
        </Button>
      </div>
      <QueryState query={report}>
        {r ? (
          <Card>
            <CardBody>
              <dl className="dl">
                <dt>{t('dueInPeriod')}</dt>
                <dd>{fmt.number(r.inspections)}</dd>
                <dt>{t('submitted')}</dt>
                <dd>{t('onTime', { n: fmt.number(r.submitted), rate: rate(r.submitted ? r.onTime / r.submitted : null) })}</dd>
                <dt>{t('open')}</dt>
                <dd>
                  {fmt.number(r.open)}
                  {r.overdue ? <Badge tone="error">{t('overdue', { n: fmt.number(r.overdue) })}</Badge> : null}
                </dd>
                <dt>{t('cancelled')}</dt>
                <dd>{fmt.number(r.cancelled)}</dd>
                <dt>{t('failedItems')}</dt>
                <dd>{fmt.number(r.failedItems)}</dd>
                <dt>{t('followedUp')}</dt>
                <dd>{t('followedUpValue', { closed: fmt.number(r.findingsClosed), total: fmt.number(r.findings), rate: rate(r.closureRate) })}</dd>
              </dl>
            </CardBody>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
