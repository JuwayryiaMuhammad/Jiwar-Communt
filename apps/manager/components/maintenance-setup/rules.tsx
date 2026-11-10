'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type MaintenanceSettings } from '@/lib/queries';
import arCommon from '@/messages/ar/ms-common';
import ar from '@/messages/ar/ms-rules';
import enCommon from '@/messages/en/ms-common';
import en from '@/messages/en/ms-rules';
import { formatClock, formatMinutes } from './format';

type Form = Record<keyof MaintenanceSettings, string>;
const FIELDS = [
  'autoCloseHours',
  'reopenDays',
  'maxReportPhotos',
  'visitHoursStart',
  'visitHoursEnd',
  'visitSlotMinutes',
  // ADR 0065.
  'replaceCostSharePct',
] as const;
const toForm = (s: MaintenanceSettings): Form => Object.fromEntries(FIELDS.map((k) => [k, String(s[k])])) as Form;

/** Half-hour steps over the day, plus the saved value when it is off the grid. */
function clockOptions(from: number, to: number, saved: number): number[] {
  const out = new Set<number>([saved]);
  for (let m = from; m <= to; m += 30) out.add(m);
  return [...out].sort((a, b) => a - b);
}
const SLOTS = [15, 30, 45, 60, 90, 120, 180, 240];

/**
 * Visiting hours and ticket limits (ADR 0032, 0038). Hours are the compound's
 * local time (its time zone is on the Settings page) and bound every visit:
 * proposals, the slots residents pick, and preventive bookings.
 */
export function Rules() {
  const t = useT(en, ar);
  const duration = useT(enCommon, arCommon);
  const common = useCommonT();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.maintenanceSettings, queryFn: fetchers.maintenanceSettings });
  const [form, setForm] = useState<Form | null>(null);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const saved = settings.data;
  const changes =
    saved && form ? Object.fromEntries(FIELDS.filter((k) => Number(form[k]) !== saved[k]).map((k) => [k, Number(form[k])])) : {};
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/maintenance/settings', { body: changes })), {
    invalidate: [keys.maintenanceSettings],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show(t('saved'));
    },
  });
  const set = (key: keyof Form, value: string) => form && setForm({ ...form, [key]: value });
  const err = (field: string) => fieldError(save.error, field);

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;
  const start = Number(form.visitHoursStart);
  const end = Number(form.visitHoursEnd);
  const slot = Number(form.visitSlotMinutes);
  const tooShort = end - start < slot;

  return (
    <form
      className="grid grid--2"
      style={{ alignItems: 'start' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !tooShort) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('visitingHours')} />
        <CardBody>
          <div className="form">
            <div className="form__row">
              <Field label={t('from')} error={err('visitHoursStart')}>
                {(p) => (
                  <Select {...p} value={form.visitHoursStart} onChange={(e) => set('visitHoursStart', e.target.value)}>
                    {clockOptions(0, 1410, saved.visitHoursStart).map((m) => (
                      <option key={m} value={m}>
                        {formatClock(m)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label={t('to')}
                error={err('visitHoursEnd') ?? (tooShort ? t('tooShort', { time: formatClock(Math.min(start + slot, 1440)) }) : undefined)}
              >
                {(p) => (
                  <Select {...p} value={form.visitHoursEnd} onChange={(e) => set('visitHoursEnd', e.target.value)}>
                    {clockOptions(30, 1440, saved.visitHoursEnd).map((m) => (
                      <option key={m} value={m}>
                        {formatClock(m)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label={t('slotLength')} hint={t('slotHint')} error={err('visitSlotMinutes')}>
              {(p) => (
                <Select {...p} value={form.visitSlotMinutes} onChange={(e) => set('visitSlotMinutes', e.target.value)}>
                  {[...new Set([...SLOTS, saved.visitSlotMinutes])]
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m}>
                        {formatMinutes(m, duration)}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <p className="t-secondary">{t('localTime')}</p>
          </div>
        </CardBody>
      </Card>
      <div className="stack">
        <Card flush>
          <CardHeader title={t('tickets')} />
          <CardBody>
            <div className="form">
              <Field
                label={t('autoClose')}
                hint={t('autoCloseHint')}
                error={err('autoCloseHours')}
              >
                {(p) => <Input {...p} type="number" min={1} max={720} value={form.autoCloseHours} onChange={(e) => set('autoCloseHours', e.target.value)} />}
              </Field>
              <Field
                label={t('reopen')}
                hint={t('reopenHint')}
                error={err('reopenDays')}
              >
                {(p) => <Input {...p} type="number" min={1} max={90} value={form.reopenDays} onChange={(e) => set('reopenDays', e.target.value)} />}
              </Field>
              <Field label={t('photos')} hint={t('photosHint')} error={err('maxReportPhotos')}>
                {(p) => <Input {...p} type="number" min={1} max={10} value={form.maxReportPhotos} onChange={(e) => set('maxReportPhotos', e.target.value)} />}
              </Field>
              <Field
                label={t('replaceAt')}
                hint={t('replaceAtHint')}
                error={err('replaceCostSharePct')}
              >
                {(p) => (
                  <Input {...p} type="number" min={1} max={100} value={form.replaceCostSharePct} onChange={(e) => set('replaceCostSharePct', e.target.value)} />
                )}
              </Field>
            </div>
          </CardBody>
        </Card>
        <ErrorAlert error={save.error} />
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          <Button disabled={!dirty} onClick={() => setForm(toForm(saved))}>
            {t('discard')}
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || tooShort} loading={save.isPending}>
            {common('saveChanges')}
          </Button>
        </span>
      </div>
    </form>
  );
}
