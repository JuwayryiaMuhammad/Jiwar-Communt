'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AnalyticsSettings } from '@/lib/queries';

const FIELDS = [
  ['recurrenceMinTickets', 'Repeat faults that suggest planned work (2–20)'],
  ['recurrenceWindowDays', 'Counted over (days, 7–366)'],
  ['caseMinTickets', 'Residents’ reports that open a community case (2–20)'],
  ['caseWindowDays', 'Counted over (days, 1–180)'],
] as const;
type Form = Record<(typeof FIELDS)[number][0], string>;

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
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.analyticsSettings, queryFn: fetchers.analyticsSettings });
  const [form, setForm] = useState<Form>(toForm(settings.data));
  useEffect(() => setForm(toForm(settings.data)), [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/settings/analytics', {
          body: Object.fromEntries(FIELDS.map(([k]) => [k, Number(form[k])])),
        }),
      ),
    { invalidate: [keys.analyticsSettings], onDone: () => toast.show('The analytics settings are saved.') },
  );
  return (
    <Card flush>
      <CardHeader title="Analytics" />
      <QueryState query={settings} rows={2}>
        <CardBody>
          <div className="stack">
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {FIELDS.map(([k, label]) => (
                <Field key={k} label={label} error={fieldError(save.error, k)}>
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
                Save
              </Button>
            </span>
            <ErrorAlert error={save.error} />
          </div>
        </CardBody>
      </QueryState>
    </Card>
  );
}
