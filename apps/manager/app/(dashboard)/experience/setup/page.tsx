'use client';

import { REASON_CODES, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ServicePromise } from '@/lib/queries';

const METRICS = ['ticket_resolution_hours', 'request_response_hours', 'ticket_rating', 'request_rating', 'partner_rating'] as const;
type Metric = (typeof METRICS)[number] | '';

/**
 * The setup of experience and recovery (ADR 0082): the rules' thresholds (a
 * count within days, or off), the compensation recommended per failure, and
 * the service promises register.
 */
export default function ExperienceSetupPage() {
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.experienceSettings, queryFn: fetchers.experienceSettings, enabled: allowed });
  const rules = useQuery({ queryKey: keys.compensationRules, queryFn: fetchers.compensationRules, enabled: allowed });
  const promises = useQuery({ queryKey: keys.servicePromises, queryFn: fetchers.servicePromises, enabled: allowed });
  const [titleEn, setTitleEn] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [metric, setMetric] = useState<Metric>('');
  const [target, setTarget] = useState('');
  const [share, setShare] = useState('');
  const refresh = { invalidate: [keys.experienceAll] };
  const saveRule = useAction(
    (item: { code: 'repeated_low_ratings' | 'reopened_tickets' | 'repeated_complaints'; count: number | null; days: number }) =>
      unwrap(api.PATCH('/api/v1/staff/experience/settings', { body: { items: [item] } })),
    { ...refresh, onDone: () => toast.show('The rule is saved.') },
  );
  const saveCompensation = useAction(
    (item: { failureCode: string; kind: 'credit' | 'apology' | 'redo' | 'priority' | null; amount?: string }) =>
      unwrap(api.PUT('/api/v1/staff/experience/compensation-rules', { body: { items: [item] } })),
    { ...refresh, onDone: () => toast.show('The recommendation is saved.') },
  );
  const addPromise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/promises', {
          body: {
            titleEn,
            titleAr,
            ...(metric
              ? {
                  metric,
                  target: Number(target),
                  ...(metric.endsWith('_hours') ? { targetShare: Number(share) } : {}),
                }
              : {}),
          },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show('The promise is in the register.');
        setTitleEn('');
        setTitleAr('');
      },
    },
  );
  const retire = useAction(
    (p: ServicePromise) =>
      unwrap(api.PATCH('/api/v1/staff/experience/promises/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    refresh,
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Experience setup" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Experience setup" description="The signals’ rules, the compensation recommended per failure, and what the compound promises." />
      <h2 className="t-title-md">Signal rules</h2>
      <Card flush>
        <QueryState query={settings}>
          <DataTable
            rows={settings.data?.rules ?? []}
            rowKey={(r) => r.code}
            columns={[
              { key: 'rule', header: 'Rule', cell: (r) => humanize(r.code) },
              { key: 'count', header: 'Events', cell: (r) => (r.count === null ? <Badge>Off</Badge> : r.count) },
              { key: 'days', header: 'Within days', cell: (r) => r.days },
              {
                key: 'toggle',
                header: '',
                cell: (r) => (
                  <Button size="sm" onClick={() => saveRule.mutate({ code: r.code, count: r.count === null ? 2 : null, days: r.days })}>
                    {r.count === null ? 'Turn on' : 'Turn off'}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={saveRule.error} />
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        Recommended compensation
      </h2>
      <Card flush>
        <QueryState query={rules}>
          <DataTable
            rows={[...REASON_CODES.creditNoteCompensation]}
            rowKey={(code) => code}
            columns={[
              { key: 'failure', header: 'What failed', cell: (code) => humanize(code) },
              {
                key: 'kind',
                header: 'Recommended',
                cell: (code) => {
                  const r = rules.data?.data.find((x) => x.failureCode === code);
                  return r ? `${humanize(r.kind)}${r.amount ? ` · ${r.amount} EGP` : ''}` : '—';
                },
              },
              {
                key: 'set',
                header: '',
                cell: (code) => (
                  <Select
                    aria-label={`Recommendation for ${code}`}
                    value=""
                    onChange={(e) => {
                      const kind = e.target.value as 'credit' | 'apology' | 'redo' | 'priority' | 'none';
                      if (kind === 'credit') {
                        const amount = window.prompt('Amount in EGP');
                        if (amount) saveCompensation.mutate({ failureCode: code, kind, amount });
                      } else saveCompensation.mutate({ failureCode: code, kind: kind === 'none' ? null : kind });
                    }}
                  >
                    <option value="">Change…</option>
                    <option value="credit">Credit</option>
                    <option value="apology">Apology</option>
                    <option value="redo">Redo the service</option>
                    <option value="priority">Priority next time</option>
                    <option value="none">No recommendation</option>
                  </Select>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={saveCompensation.error} />
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        Service promises
      </h2>
      <Card flush>
        <QueryState query={promises}>
          <DataTable<ServicePromise>
            rows={promises.data?.data ?? []}
            rowKey={(p) => p.id}
            empty="No promise yet"
            columns={[
              { key: 'title', header: 'Promise', cell: (p) => p.titleEn },
              {
                key: 'target',
                header: 'Target',
                cell: (p) =>
                  p.metric
                    ? `${humanize(p.metric)} · ${p.target}${p.targetShare ? ` for ${p.targetShare}%` : ''}`
                    : 'Not measured',
              },
              { key: 'active', header: '', cell: (p) => <Button size="sm" onClick={() => retire.mutate(p)}>{p.active ? 'Retire' : 'Restore'}</Button> },
            ]}
          />
        </QueryState>
      </Card>
      <form
        className="form__row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          addPromise.mutate();
        }}
      >
        <Field label="Promise (English)">{(p) => <Input {...p} value={titleEn} maxLength={200} onChange={(e) => setTitleEn(e.target.value)} />}</Field>
        <Field label="Promise (Arabic)">{(p) => <Input {...p} dir="rtl" value={titleAr} maxLength={200} onChange={(e) => setTitleAr(e.target.value)} />}</Field>
        <Field label="Measured by">
          {(p) => (
            <Select {...p} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
              <option value="">Not measured</option>
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {humanize(m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {metric ? (
          <Field label={metric.endsWith('_hours') ? 'Hours' : 'Average at least'}>
            {(p) => <Input {...p} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />}
          </Field>
        ) : null}
        {metric.endsWith('_hours') ? (
          <Field label="For % of them">{(p) => <Input {...p} inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />}</Field>
        ) : null}
        <Button type="submit" variant="primary" loading={addPromise.isPending} disabled={!titleEn || !titleAr}>
          Add
        </Button>
      </form>
      <ErrorAlert error={addPromise.error ?? retire.error} />
    </>
  );
}
