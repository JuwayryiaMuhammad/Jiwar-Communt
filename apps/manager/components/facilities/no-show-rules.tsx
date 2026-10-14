'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type FacilitySettings } from '@/lib/queries';
import { inRange, numberChanges, SETTING_FIELDS, SETTING_RANGES, type SettingField } from './logic';

type Form = Record<SettingField, string>;
const toForm = (s: FacilitySettings): Form => Object.fromEntries(SETTING_FIELDS.map((k) => [k, String(s[k])])) as Form;

const COPY: Record<SettingField, { label: string; hint: string }> = {
  noShowThreshold: { label: 'No-shows that suspend a unit', hint: 'Counted over the window, since the unit’s last suspension began.' },
  noShowWindowDays: { label: 'Window, days', hint: 'How far back the no-shows are counted.' },
  suspensionDays: { label: 'Suspension, days', hint: 'How long the unit cannot make a new booking. What it holds stays.' },
};

/** The compound's no-show rules (ADR 0044). A change applies to the next no-show. */
export function NoShowRules() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.facilitySettings, queryFn: fetchers.facilitySettings });
  const [form, setForm] = useState<Form | null>(null);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);
  const saved = settings.data;
  const invalid = form ? SETTING_FIELDS.some((k) => !inRange(SETTING_RANGES[k], form[k])) : true;
  const changes = saved && form && !invalid ? numberChanges(form, saved, SETTING_FIELDS) : {};
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facility-settings', { body: changes })), {
    invalidate: [keys.facilitySettings],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show('No-show rules saved.');
    },
  });
  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;

  return (
    <form
      className="stack"
      style={{ maxWidth: 560 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title="No-shows" />
        <CardBody>
          <div className="form">
            {SETTING_FIELDS.map((key) => {
              const { min, max } = SETTING_RANGES[key];
              return (
                <Field
                  key={key}
                  label={COPY[key].label}
                  hint={`${COPY[key].hint} From ${min} to ${max}.`}
                  error={fieldError(save.error, key) ?? (inRange(SETTING_RANGES[key], form[key]) ? undefined : `A whole number from ${min} to ${max}.`)}
                >
                  {(p) => <Input {...p} type="number" min={min} max={max} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
                </Field>
              );
            })}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          Save
        </Button>
      </span>
    </form>
  );
}
