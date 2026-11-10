'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type RequestSettings } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-setup';
import en from '@/messages/en/services-mgmt-setup';

type Form = Record<keyof RequestSettings, string>;
const FIELDS = ['autoCloseDays', 'appointmentSlotMinutes', 'appointmentSlotCapacity'] as const;
const RANGES: Record<(typeof FIELDS)[number], { min: number; max: number }> = {
  autoCloseDays: { min: 1, max: 90 },
  appointmentSlotMinutes: { min: 10, max: 240 },
  appointmentSlotCapacity: { min: 1, max: 50 },
};
const SLOTS = [15, 20, 30, 45, 60, 90, 120];
const toForm = (s: RequestSettings): Form => Object.fromEntries(FIELDS.map((k) => [k, String(s[k])])) as Form;
const valid = (key: (typeof FIELDS)[number], value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= RANGES[key].min && n <= RANGES[key].max;
};

/**
 * When an answered request closes by itself, and how appointments are cut
 * and filled (ADR 0039). Only what changed is sent.
 */
export function Rules() {
  const t = useT(en, ar);
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.requestSettings, queryFn: fetchers.requestSettings });
  const [form, setForm] = useState<Form | null>(null);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const saved = settings.data;
  const changes =
    saved && form ? Object.fromEntries(FIELDS.filter((k) => Number(form[k]) !== saved[k]).map((k) => [k, Number(form[k])])) : {};
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/management/request-settings', { body: changes })), {
    invalidate: [keys.requestSettings, keys.managementAll],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show(t('rulesSaved'));
    },
  });

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;
  const set = (key: keyof Form, value: string) => setForm({ ...form, [key]: value });
  const err = (key: (typeof FIELDS)[number]) =>
    fieldError(save.error, key) ?? (valid(key, form[key]) ? undefined : t('wholeNumber', { min: RANGES[key].min, max: RANGES[key].max }));
  const invalid = FIELDS.some((k) => !valid(k, form[k]));
  const slotOptions = [...new Set([...SLOTS, saved.appointmentSlotMinutes])].sort((a, b) => a - b);

  return (
    <form
      className="grid grid--2"
      style={{ alignItems: 'start' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('autoClose')} />
        <CardBody>
          <div className="form">
            <Field
              label={t('autoCloseDays')}
              hint={t('autoCloseHint')}
              error={err('autoCloseDays')}
            >
              {(p) => (
                <Input {...p} type="number" min={1} max={90} step={1} value={form.autoCloseDays} onChange={(e) => set('autoCloseDays', e.target.value)} />
              )}
            </Field>
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title={t('appointments')} />
        <CardBody>
          <div className="form">
            <div className="form__row">
              <Field label={t('slotLength')} error={err('appointmentSlotMinutes')}>
                {(p) => (
                  <Select {...p} value={form.appointmentSlotMinutes} onChange={(e) => set('appointmentSlotMinutes', e.target.value)}>
                    {slotOptions.map((m) => (
                      <option key={m} value={m}>
                        {t('minutes', { n: m })}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('perSlot')} error={err('appointmentSlotCapacity')}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    value={form.appointmentSlotCapacity}
                    onChange={(e) => set('appointmentSlotCapacity', e.target.value)}
                  />
                )}
              </Field>
            </div>
            <p className="t-secondary">{t('slotsNote')}</p>
          </div>
        </CardBody>
      </Card>
      <div style={{ gridColumn: '1 / -1' }}>
        <ErrorAlert error={save.error} />
        <span className="row">
          <span className="spacer" />
          <Button type="button" disabled={!dirty} onClick={() => setForm(toForm(saved))}>
            {t('discard')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            {t('saveRules')}
          </Button>
        </span>
      </div>
    </form>
  );
}
