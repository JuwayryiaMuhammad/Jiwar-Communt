'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AnalyticsSettings } from '@/lib/queries';
import ar from '@/messages/ar/ms-analytics';
import en from '@/messages/en/ms-analytics';

const FIELDS = ['recurrenceMinTickets', 'recurrenceWindowDays', 'caseMinTickets', 'caseWindowDays'] as const;
type Form = Record<(typeof FIELDS)[number], string>;

const toForm = (s?: AnalyticsSettings): Form => ({
  recurrenceMinTickets: String(s?.recurrenceMinTickets ?? ''),
  recurrenceWindowDays: String(s?.recurrenceWindowDays ?? ''),
  caseMinTickets: String(s?.caseMinTickets ?? ''),
  caseWindowDays: String(s?.caseWindowDays ?? ''),
});

/**
 * The maintenance analytics' numbers (ADR 0081): when a category's repairs
 * on one asset or in one unit suggest planned work, and when a building's
 * residents' tickets of one category open a community case. A new number
 * applies to the next ticket.
 */
export function AnalyticsSettingsCard() {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.analyticsSettings, queryFn: fetchers.analyticsSettings });
  const [form, setForm] = useState<Form>(toForm(settings.data));
  useEffect(() => setForm(toForm(settings.data)), [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/settings/analytics', {
          body: Object.fromEntries(FIELDS.map((k) => [k, Number(form[k])])),
        }),
      ),
    { invalidate: [keys.analyticsSettings], onDone: () => toast.show(t('analyticsSaved')) },
  );
  return (
    <Card flush>
      <CardHeader title={t('analytics')} />
      <QueryState query={settings} rows={2}>
        <CardBody>
          <div className="stack">
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {FIELDS.map((k) => (
                <Field key={k} label={t(`field.${k}`)} error={fieldError(save.error, k)}>
                  {(f) => (
                    <Input
                      {...f}
                      inputMode="numeric"
                      style={{ maxWidth: 120 }}
                      value={form[k]}
                      onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
            <span>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                {c('save')}
              </Button>
            </span>
            <ErrorAlert error={save.error} />
          </div>
        </CardBody>
      </QueryState>
    </Card>
  );
}
