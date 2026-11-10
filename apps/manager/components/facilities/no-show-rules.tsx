'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type FacilitySettings } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { inRange, numberChanges, SETTING_FIELDS, SETTING_RANGES, type SettingField } from './logic';

type Form = Record<SettingField, string>;
const toForm = (s: FacilitySettings): Form => Object.fromEntries(SETTING_FIELDS.map((k) => [k, String(s[k])])) as Form;

/** The compound's no-show rules (ADR 0044). A change applies to the next no-show. */
export function NoShowRules() {
  const t = useT(en, ar);
  const c = useCommonT();
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
      toast.show(t('noShow.saved'));
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
        <CardHeader title={t('noShow.title')} />
        <CardBody>
          <div className="form">
            {SETTING_FIELDS.map((key) => {
              const { min, max } = SETTING_RANGES[key];
              return (
                <Field
                  key={key}
                  label={t(`noShow.${key}`)}
                  hint={t(`noShow.${key}.hint`, { min, max })}
                  error={fieldError(save.error, key) ?? (inRange(SETTING_RANGES[key], form[key]) ? undefined : t('wholeRange', { min, max }))}
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
          {c('save')}
        </Button>
      </span>
    </form>
  );
}
