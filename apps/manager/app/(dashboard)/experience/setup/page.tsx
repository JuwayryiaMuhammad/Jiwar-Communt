'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ServicePromise } from '@/lib/queries';
import ar from '@/messages/ar/experience-setup';
import en from '@/messages/en/experience-setup';

const METRICS = ['ticket_resolution_hours', 'request_response_hours', 'ticket_rating', 'request_rating', 'partner_rating'] as const;
type Metric = (typeof METRICS)[number] | '';

/**
 * The setup of experience and recovery (ADR 0082): the rules' thresholds (a
 * count within days, or off), the compensation recommended per failure, and
 * the service promises register.
 */
export default function ExperienceSetupPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
    { ...refresh, onDone: () => toast.show(t('setup.ruleSaved')) },
  );
  const saveCompensation = useAction(
    (item: { failureCode: string; kind: 'credit' | 'apology' | 'redo' | 'priority' | null; amount?: string }) =>
      unwrap(api.PUT('/api/v1/staff/experience/compensation-rules', { body: { items: [item] } })),
    { ...refresh, onDone: () => toast.show(t('setup.recommendationSaved')) },
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
        toast.show(t('setup.promiseAdded'));
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
        <PageHeader title={t('setup.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('setup.title')} description={t('setup.description')} />
      <h2 className="t-title-md">{t('setup.rules')}</h2>
      <Card flush>
        <QueryState query={settings}>
          <DataTable
            rows={settings.data?.rules ?? []}
            rowKey={(r) => r.code}
            columns={[
              { key: 'rule', header: t('setup.rule'), cell: (r) => label(r.code) },
              { key: 'count', header: t('setup.events'), cell: (r) => (r.count === null ? <Badge>{t('setup.off')}</Badge> : f.number(r.count)) },
              { key: 'days', header: t('setup.withinDays'), cell: (r) => f.number(r.days) },
              {
                key: 'toggle',
                header: '',
                cell: (r) => (
                  <Button size="sm" onClick={() => saveRule.mutate({ code: r.code, count: r.count === null ? 2 : null, days: r.days })}>
                    {r.count === null ? t('setup.turnOn') : t('setup.turnOff')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={saveRule.error} />
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        {t('setup.recommended')}
      </h2>
      <Card flush>
        <QueryState query={rules}>
          <DataTable
            rows={[...REASON_CODES.creditNoteCompensation]}
            rowKey={(code) => code}
            columns={[
              { key: 'failure', header: t('setup.failed'), cell: (code) => label(code) },
              {
                key: 'kind',
                header: t('setup.recommendation'),
                cell: (code) => {
                  const r = rules.data?.data.find((x) => x.failureCode === code);
                  return r ? `${label(r.kind)}${r.amount ? ` · ${f.money(r.amount)}` : ''}` : '—';
                },
              },
              {
                key: 'set',
                header: '',
                cell: (code) => (
                  <Select
                    aria-label={t('setup.recommendationFor', { what: label(code) })}
                    value=""
                    onChange={(e) => {
                      const kind = e.target.value as 'credit' | 'apology' | 'redo' | 'priority' | 'none';
                      if (kind === 'credit') {
                        const amount = window.prompt(t('setup.amountPrompt'));
                        if (amount) saveCompensation.mutate({ failureCode: code, kind, amount });
                      } else saveCompensation.mutate({ failureCode: code, kind: kind === 'none' ? null : kind });
                    }}
                  >
                    <option value="">{t('setup.change')}</option>
                    <option value="credit">{t('setup.credit')}</option>
                    <option value="apology">{t('setup.apology')}</option>
                    <option value="redo">{t('setup.redo')}</option>
                    <option value="priority">{t('setup.priority')}</option>
                    <option value="none">{t('setup.none')}</option>
                  </Select>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={saveCompensation.error} />
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        {t('setup.promises')}
      </h2>
      <Card flush>
        <QueryState query={promises}>
          <DataTable<ServicePromise>
            rows={promises.data?.data ?? []}
            rowKey={(p) => p.id}
            empty={t('setup.noPromises')}
            columns={[
              { key: 'title', header: t('setup.promise'), cell: (p) => (locale === 'ar' ? p.titleAr : p.titleEn) },
              {
                key: 'target',
                header: t('setup.target'),
                cell: (p) =>
                  p.metric
                    ? p.targetShare
                      ? t('setup.targetShare', { metric: label(p.metric), target: f.number(p.target), share: f.percent(p.targetShare / 100, 0) })
                      : t('setup.targetLine', { metric: label(p.metric), target: f.number(p.target) })
                    : t('reports.notMeasured'),
              },
              { key: 'active', header: '', cell: (p) => <Button size="sm" onClick={() => retire.mutate(p)}>{p.active ? t('setup.retire') : t('setup.restore')}</Button> },
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
        <Field label={t('setup.promiseEn')}>{(p) => <Input {...p} value={titleEn} maxLength={200} onChange={(e) => setTitleEn(e.target.value)} />}</Field>
        <Field label={t('setup.promiseAr')}>{(p) => <Input {...p} dir="rtl" value={titleAr} maxLength={200} onChange={(e) => setTitleAr(e.target.value)} />}</Field>
        <Field label={t('setup.measuredBy')}>
          {(p) => (
            <Select {...p} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
              <option value="">{t('reports.notMeasured')}</option>
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {metric ? (
          <Field label={metric.endsWith('_hours') ? t('setup.hours') : t('setup.averageAtLeast')}>
            {(p) => <Input {...p} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />}
          </Field>
        ) : null}
        {metric.endsWith('_hours') ? (
          <Field label={t('setup.forShare')}>{(p) => <Input {...p} inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />}</Field>
        ) : null}
        <Button type="submit" variant="primary" loading={addPromise.isPending} disabled={!titleEn || !titleAr}>
          {t('setup.add')}
        </Button>
      </form>
      <ErrorAlert error={addPromise.error ?? retire.error} />
    </>
  );
}
