'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/experience-setup';
import en from '@/messages/en/experience-setup';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The ratings report and the promises against their targets (ADR 0082),
 * over the compound's days: never who rated, never a comment. The board
 * reads the same totals in its overview and its monthly report.
 */
export default function ExperienceReportsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const ratings = useQuery({ queryKey: keys.ratingsReport(from, to), queryFn: () => fetchers.ratingsReport(from, to), enabled: allowed });
  const promises = useQuery({ queryKey: keys.promisesReport(from, to), queryFn: () => fetchers.promisesReport(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('reports.title')} />
        <ForbiddenState />
      </>
    );
  const r = ratings.data;
  return (
    <>
      <PageHeader title={t('reports.title')} description={t('reports.description')} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={ratings}>
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          {(r?.bySource ?? []).map((s) => (
            <Card key={s.source}>
              <div className="stack stack--sm" style={{ padding: 12 }}>
                <span className="t-secondary">{label(s.source)}</span>
                <strong className="t-title-md">{f.number(s.average)}</strong>
                <span className="t-secondary">
                  {t('reports.rated', { count: f.number(s.count), low: f.number(s.low) })}
                </span>
              </div>
            </Card>
          ))}
        </div>
        <h2 className="t-title-md">{t('reports.whyLow')}</h2>
        <Card flush>
          <DataTable
            rows={r?.reasons ?? []}
            rowKey={(x) => x.code}
            empty={t('reports.noReason')}
            columns={[
              { key: 'code', header: c('reason'), cell: (x) => label(x.code) },
              { key: 'count', header: t('reports.ratings'), cell: (x) => f.number(x.count) },
              { key: 'share', header: t('reports.share'), cell: (x) => f.percent(x.share / 100) },
            ]}
          />
        </Card>
        <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
          {t('reports.byBuilding')}
        </h2>
        <Card flush>
          <DataTable
            rows={r?.byBuilding ?? []}
            rowKey={(x) => x.building ?? '—'}
            columns={[
              { key: 'building', header: c('building'), cell: (x) => x.building ?? t('reports.noBuilding') },
              { key: 'count', header: t('reports.rated.col'), cell: (x) => f.number(x.count) },
              { key: 'avg', header: t('reports.average'), cell: (x) => f.number(x.average) },
              { key: 'low', header: t('reports.low'), cell: (x) => f.number(x.low) },
            ]}
          />
        </Card>
        <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
          {t('reports.repeat')}
        </h2>
        <Card flush>
          <DataTable
            rows={r?.units ?? []}
            rowKey={(x) => x.unitId}
            empty={c('none')}
            columns={[
              { key: 'unit', header: c('unit'), cell: (x) => x.unitCode ?? '—' },
              { key: 'low', header: t('reports.lowRatings'), cell: (x) => f.number(x.low) },
            ]}
          />
        </Card>
      </QueryState>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        {t('reports.promises')}
      </h2>
      <QueryState query={promises}>
        <Card flush>
          <DataTable
            rows={promises.data?.items ?? []}
            rowKey={(x) => x.promise.id}
            empty={t('reports.noPromise')}
            columns={[
              { key: 'title', header: t('reports.promise'), cell: (x) => (locale === 'ar' ? x.promise.titleAr : x.promise.titleEn) },
              {
                key: 'value',
                header: t('reports.measured'),
                cell: (x) => (x.measured ? (x.value === null ? t('reports.nothingToMeasure') : f.number(x.value)) : t('reports.notMeasured')),
              },
              { key: 'items', header: t('reports.items'), cell: (x) => f.number(x.items) },
              { key: 'met', header: '', cell: (x) => (x.met === null ? null : <Badge>{x.met ? t('reports.kept') : t('reports.missed')}</Badge>) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
