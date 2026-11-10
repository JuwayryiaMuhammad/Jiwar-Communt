'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { LIMIT_FIELDS, LIMIT_RANGES, limitChanges, validLimit, type LimitField } from '@/components/neighbours/logic';
import { api } from '@/lib/api';
import { fetchers, keys, type NeighbourSettings } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-setup';
import en from '@/messages/en/neighbours-setup';

type Form = Record<LimitField, string>;
const toForm = (s: NeighbourSettings): Form => Object.fromEntries(LIMIT_FIELDS.map((k) => [k, String(s[k])])) as Form;

/**
 * The compound's limits for complaints and the boards (ADR 0042). Only what
 * changed is sent; a change applies from now on, and posts already up keep
 * the day they were given.
 */
export function Limits() {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.neighbourSettings, queryFn: fetchers.neighbourSettings });
  const [form, setForm] = useState<Form | null>(null);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const saved = settings.data;
  const invalid = form ? LIMIT_FIELDS.some((k) => !validLimit(k, form[k])) : true;
  const changes = saved && form && !invalid ? limitChanges(form, saved) : {};
  const dirty = saved && form ? LIMIT_FIELDS.some((k) => form[k].trim() !== String(saved[k])) : false;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/neighbours/settings', { body: changes })), {
    invalidate: [keys.neighbourSettings],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show(t('limits.saved'));
    },
  });

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;
  const field = (key: LimitField) => {
    const { min, max } = LIMIT_RANGES[key];
    return (
      <Field
        label={t(`${key}.label`)}
        hint={t('limits.range', { hint: t(`${key}.hint`), min: f.number(min), max: f.number(max) })}
        error={fieldError(save.error, key) ?? (validLimit(key, form[key]) ? undefined : t('limits.rangeError', { min: f.number(min), max: f.number(max) }))}
      >
        {(p) => <Input {...p} className="ltr" type="number" min={min} max={max} step={1} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
      </Field>
    );
  };

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
        <CardHeader title={t('limits.complaints')} />
        <CardBody>
          <div className="form">{field('maxOpenComplaints')}</div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title={t('limits.boards')} />
        <CardBody>
          <div className="form">
            <div className="form__row">
              {field('lostFoundExpiryDays')}
              {field('lendingExpiryDays')}
            </div>
            <div className="form__row">
              {field('maxOpenPosts')}
              {field('maxNewConversationsPerDay')}
            </div>
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
            {t('limits.save')}
          </Button>
        </span>
      </div>
    </form>
  );
}
