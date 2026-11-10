'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanSuggestion, type RecurrencePlace, type RecurrenceReport } from '@/lib/queries';
import ar from '@/messages/ar/recurrence';
import en from '@/messages/en/recurrence';

type Row = RecurrenceReport['rows'][number];
const PLACES: RecurrencePlace[] = ['asset', 'unit', 'building', 'common_area'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Repeat faults (ADR 0081): the repairs of a category at a place over a
 * period, from the compound's threshold on; and the plan suggestions they
 * made, taken into a plan or dismissed by whoever keeps the plans.
 */
export default function RecurrencePage() {
  const t = useT(en, ar);
  const label = useLabel();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 89 * 24 * 3_600_000)));
  const [by, setBy] = useState<RecurrencePlace>('asset');
  const report = useQuery({
    queryKey: keys.recurrence({ from, to, by }),
    queryFn: () => fetchers.recurrence({ from, to, by }),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={t('by')}>
          {(p) => (
            <Select {...p} value={by} onChange={(e) => setBy(e.target.value as RecurrencePlace)}>
              {PLACES.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <QueryState query={report}>
        <Card flush>
          <DataTable<Row>
            rows={report.data?.rows ?? []}
            rowKey={(r) => `${r.placeId}:${r.categoryId}`}
            empty={t('empty')}
            columns={[
              { key: 'place', header: label(by), cell: (r) => r.placeCode ?? '—' },
              { key: 'category', header: t('col.category'), cell: (r) => label(r.categoryKey) },
              { key: 'count', header: t('col.tickets'), cell: (r) => r.count },
              { key: 'gap', header: t('col.gap'), cell: (r) => r.meanIntervalDays },
              { key: 'cost', header: t('col.cost'), cell: (r) => r.cost },
              { key: 'last', header: t('col.last'), cell: (r) => f.dateTime(r.lastAt) },
              {
                key: 'months',
                header: t('col.months'),
                cell: (r) => r.months.map((m) => `${f.month(m.month)}: ${m.count}`).join(' · '),
              },
            ]}
          />
        </Card>
        {report.data?.truncated ? <p className="t-secondary">{t('truncated')}</p> : null}
      </QueryState>
      {can('assets.read') ? <Suggestions mayDecide={can('assets.manage')} /> : null}
    </>
  );
}

function Suggestions({ mayDecide }: { mayDecide: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const fmt = useFormat();
  const toast = useToast();
  const [status, setStatus] = useState<PlanSuggestion['status'] | ''>('open');
  const [accepting, setAccepting] = useState<PlanSuggestion | null>(null);
  const [dismissing, setDismissing] = useState<PlanSuggestion | null>(null);
  const [form, setForm] = useState({ title: '', every: '1', unit: 'month', anchorOn: iso(new Date()), planId: '' });
  const list = useCursorList(keys.planSuggestions(status), (c) => fetchers.planSuggestions(status, c));
  const accept = useAction(
    (s: PlanSuggestion) =>
      unwrap(
        api.POST('/api/v1/maintenance/plan-suggestions/{id}/accept', {
          params: { path: { id: s.id } },
          body: form.planId
            ? { planId: form.planId }
            : {
                plan: {
                  assetId: s.assetId ?? '',
                  title: form.title,
                  trigger: 'calendar',
                  every: Number(form.every),
                  unit: form.unit as 'month',
                  anchorOn: form.anchorOn,
                  priority: 'normal',
                  leadDays: 7,
                  graceDays: 3,
                },
              },
        }),
      ),
    {
      invalidate: [keys.planSuggestions(status)],
      onDone: () => {
        toast.show(t('takenIn'));
        setAccepting(null);
      },
    },
  );
  const dismiss = useAction(
    (r: { s: PlanSuggestion; code: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/plan-suggestions/{id}/dismiss', {
          params: { path: { id: r.s.id } },
          body: { reasonCode: r.code },
        }),
      ),
    {
      invalidate: [keys.planSuggestions(status)],
      onDone: () => {
        toast.show(t('dismissed'));
        setDismissing(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title={t('suggestionsTitle')}
        description={t('suggestionsDescription')}
      />
      <div className="toolbar">
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as PlanSuggestion['status'] | '')}>
              <option value="">{t('anyStatus')}</option>
              {(['open', 'accepted', 'dismissed'] as const).map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PlanSuggestion>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={t('emptySuggestions')}
            columns={[
              { key: 'made', header: t('col.made'), width: 170, cell: (s) => fmt.dateTime(s.createdAt) },
              { key: 'place', header: t('col.place'), cell: (s) => t(s.assetId ? 'placeAsset' : 'placeUnit', { code: s.placeCode ?? '' }) },
              { key: 'category', header: t('col.category'), cell: (s) => label(s.categoryKey) },
              { key: 'count', header: t('col.faults'), cell: (s) => t('faultsIn', { n: s.ticketCount, days: s.windowDays }) },
              { key: 'status', header: t('col.status'), cell: (s) => <Badge>{label(s.status)}</Badge> },
              {
                key: 'act',
                header: '',
                cell: (s) =>
                  mayDecide && s.status === 'open' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setAccepting(s)}>
                        {t('takeIntoPlan')}
                      </Button>
                      <Button size="sm" variant="text" onClick={() => setDismissing(s)}>
                        {t('dismiss')}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <Dialog
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title={t('takeTitle')}
        footer={
          <Button variant="primary" loading={accept.isPending} onClick={() => accepting && accept.mutate(accepting)}>
            {c('save')}
          </Button>
        }
      >
        <div className="stack">
          <p className="t-secondary">{t('takeHint')}</p>
          <Field label={t('existingPlan')}>
            {(p) => <Input {...p} value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))} />}
          </Field>
          <Field label={t('planTitle')}>
            {(p) => <Input {...p} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />}
          </Field>
          <div className="form__row">
            <Field label={t('every')}>
              {(p) => <Input {...p} inputMode="numeric" value={form.every} onChange={(e) => setForm((f) => ({ ...f, every: e.target.value }))} />}
            </Field>
            <Field label={t('unit')}>
              {(p) => (
                <Select {...p} value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                  {['week', 'month', 'year'].map((u) => (
                    <option key={u} value={u}>
                      {label(u)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('from')}>
              {(p) => <Input {...p} type="date" value={form.anchorOn} onChange={(e) => setForm((f) => ({ ...f, anchorOn: e.target.value }))} />}
            </Field>
          </div>
          <ErrorAlert error={accept.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title={t('dismissTitle')}
        description={t('dismissDescription')}
        codes={REASON_CODES.planSuggestionDismiss}
        confirmLabel={t('dismiss')}
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(code) => dismissing && dismiss.mutate({ s: dismissing, code })}
      />
    </>
  );
}
