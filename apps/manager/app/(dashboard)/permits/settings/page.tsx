'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, Checkbox, Field, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { describeDays, toggleDay, validHours } from '@/components/permits/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PermitSettings } from '@/lib/queries';
import ar from '@/messages/ar/places-permits';
import en from '@/messages/en/places-permits';

/** 0 = Sunday … 6 = Saturday, as the API counts them. */
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The compound's work days and hours for works and moves (ADR 0049). Its
 * days off are the holiday calendar's that stop works (ADR 0084): shown
 * here, kept on the holidays page.
 */
export default function PermitSettingsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const settings = useQuery({ queryKey: keys.permitSettings, queryFn: fetchers.permitSettings, enabled: allowed });
  const [form, setForm] = useState<PermitSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useAction(
    // The days off are not the permits' to change any more (ADR 0084).
    (body: PermitSettings) =>
      unwrap(api.PATCH('/api/v1/staff/permit-settings', {
          body: { workDays: body.workDays, workHours: body.workHours, worksDepositRequired: body.worksDepositRequired },
        })),
    {
      invalidate: [keys.permitSettings],
      onDone: () => toast.show(t('settings.saved')),
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('settings.title')} />
        <ForbiddenState />
      </>
    );
  const ok = form !== null && form.workDays.length > 0 && validHours(form.workHours.from, form.workHours.to);
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <QueryState query={settings}>
        {form ? (
          <Card>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (ok) save.mutate(form);
              }}
            >
              <Field label={t('settings.workDays', { days: describeDays(form.workDays, fmt, t) })} error={fieldError(save.error, 'workDays')}>
                {() => (
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                    {DAYS.map((day) => (
                      <Checkbox
                        key={day}
                        label={fmt.weekday(day, 'short')}
                        checked={form.workDays.includes(day)}
                        onChange={() => setForm({ ...form, workDays: toggleDay(form.workDays, day) })}
                      />
                    ))}
                  </div>
                )}
              </Field>
              <div className="row" style={{ gap: 12 }}>
                <Field label={c('from')} error={fieldError(save.error, 'workHours')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="time"
                      value={form.workHours.from}
                      onChange={(e) => setForm({ ...form, workHours: { ...form.workHours, from: e.target.value } })}
                    />
                  )}
                </Field>
                <Field label={c('to')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="time"
                      value={form.workHours.to}
                      onChange={(e) => setForm({ ...form, workHours: { ...form.workHours, to: e.target.value } })}
                    />
                  )}
                </Field>
              </div>
              <Field label={t('settings.daysOff')} hint={t('settings.daysOffHint')}>
                {() => (
                  <div className="stack stack--sm">
                    {form.daysOff.length ? (
                      form.daysOff.map((d) => <span key={d}>{fmt.day(d)}</span>)
                    ) : (
                      <span className="muted">{c('none')}</span>
                    )}
                    <Link className="table__link" href="/holidays">
                      {t('settings.openHolidays')}
                    </Link>
                  </div>
                )}
              </Field>
              <Checkbox
                label={t('settings.deposit')}
                checked={form.worksDepositRequired}
                onChange={(e) => setForm({ ...form, worksDepositRequired: e.target.checked })}
              />
              <ErrorAlert error={save.error} />
              <div>
                <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
                  {c('save')}
                </Button>
              </div>
            </form>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
