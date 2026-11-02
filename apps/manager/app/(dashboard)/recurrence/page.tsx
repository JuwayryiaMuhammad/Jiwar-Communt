'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanSuggestion, type RecurrencePlace, type RecurrenceReport } from '@/lib/queries';

type Row = RecurrenceReport['rows'][number];
const PLACES: RecurrencePlace[] = ['asset', 'unit', 'building', 'common_area'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Repeat faults (ADR 0081): the repairs of a category at a place over a
 * period, from the compound's threshold on; and the plan suggestions they
 * made, taken into a plan or dismissed by whoever keeps the plans.
 */
export default function RecurrencePage() {
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
        <PageHeader title="Repeat faults" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Repeat faults"
        description="The repairs of one category at one place over the period, from the compound’s threshold on: how many, how far apart, what they cost. Planned work and cancelled tickets are not faults."
      />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="By">
          {(p) => (
            <Select {...p} value={by} onChange={(e) => setBy(e.target.value as RecurrencePlace)}>
              {PLACES.map((x) => (
                <option key={x} value={x}>
                  {humanize(x)}
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
            empty="No place reached the threshold in this period"
            columns={[
              { key: 'place', header: humanize(by), cell: (r) => r.placeCode ?? '—' },
              { key: 'category', header: 'Category', cell: (r) => humanize(r.categoryKey) },
              { key: 'count', header: 'Tickets', cell: (r) => r.count },
              { key: 'gap', header: 'Mean gap (days)', cell: (r) => r.meanIntervalDays },
              { key: 'cost', header: 'Cost (EGP)', cell: (r) => r.cost },
              { key: 'last', header: 'Last', cell: (r) => formatDateTime(r.lastAt) },
              {
                key: 'months',
                header: 'By month',
                cell: (r) => r.months.map((m) => `${m.month}: ${m.count}`).join(' · '),
              },
            ]}
          />
        </Card>
        {report.data?.truncated ? <p className="t-secondary">Only the first 500 rows are shown.</p> : null}
      </QueryState>
      {can('assets.read') ? <Suggestions mayDecide={can('assets.manage')} /> : null}
    </>
  );
}

function Suggestions({ mayDecide }: { mayDecide: boolean }) {
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
        toast.show('Taken into a plan.');
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
        toast.show('Dismissed. It is not suggested again for a window.');
        setDismissing(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title="Plan suggestions"
        description="Made when a category’s repairs on one asset, or in one unit, reach the threshold. Nothing changes a plan by itself: take it into a new plan, or a plan that covers it, or dismiss it."
      />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as PlanSuggestion['status'] | '')}>
              <option value="">Any status</option>
              {(['open', 'accepted', 'dismissed'] as const).map((x) => (
                <option key={x} value={x}>
                  {humanize(x)}
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
            empty="No suggestion"
            columns={[
              { key: 'made', header: 'Made', width: 170, cell: (s) => formatDateTime(s.createdAt) },
              { key: 'place', header: 'Place', cell: (s) => `${s.assetId ? 'Asset' : 'Unit'} ${s.placeCode ?? ''}` },
              { key: 'category', header: 'Category', cell: (s) => humanize(s.categoryKey) },
              { key: 'count', header: 'Faults', cell: (s) => `${s.ticketCount} in ${s.windowDays} days` },
              { key: 'status', header: 'Status', cell: (s) => <Badge>{humanize(s.status)}</Badge> },
              {
                key: 'act',
                header: '',
                cell: (s) =>
                  mayDecide && s.status === 'open' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setAccepting(s)}>
                        Take into a plan
                      </Button>
                      <Button size="sm" variant="text" onClick={() => setDismissing(s)}>
                        Dismiss
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
        title="Take into a plan"
        footer={
          <Button variant="primary" loading={accept.isPending} onClick={() => accepting && accept.mutate(accepting)}>
            Save
          </Button>
        }
      >
        <div className="stack">
          <p className="t-secondary">
            A new calendar plan on the asset, or the id of an active plan that covers it already (left as it is). A
            unit’s suggestion takes a plan on an asset of a common area that serves it.
          </p>
          <Field label="Existing plan id (optional)">
            {(p) => <Input {...p} value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))} />}
          </Field>
          <Field label="New plan’s title">
            {(p) => <Input {...p} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />}
          </Field>
          <div className="form__row">
            <Field label="Every">
              {(p) => <Input {...p} inputMode="numeric" value={form.every} onChange={(e) => setForm((f) => ({ ...f, every: e.target.value }))} />}
            </Field>
            <Field label="Unit">
              {(p) => (
                <Select {...p} value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                  {['week', 'month', 'year'].map((u) => (
                    <option key={u} value={u}>
                      {humanize(u)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="From">
              {(p) => <Input {...p} type="date" value={form.anchorOn} onChange={(e) => setForm((f) => ({ ...f, anchorOn: e.target.value }))} />}
            </Field>
          </div>
          <ErrorAlert error={accept.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title="Dismiss this suggestion?"
        description="It is not suggested again for the compound’s window."
        codes={REASON_CODES.planSuggestionDismiss}
        confirmLabel="Dismiss"
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(code) => dismissing && dismiss.mutate({ s: dismissing, code })}
      />
    </>
  );
}
