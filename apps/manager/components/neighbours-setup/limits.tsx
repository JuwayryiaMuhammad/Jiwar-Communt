'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { LIMIT_FIELDS, LIMIT_RANGES, limitChanges, validLimit, type LimitField } from '@/components/neighbours/logic';
import { api } from '@/lib/api';
import { fetchers, keys, type NeighbourSettings } from '@/lib/queries';

type Form = Record<LimitField, string>;
const toForm = (s: NeighbourSettings): Form => Object.fromEntries(LIMIT_FIELDS.map((k) => [k, String(s[k])])) as Form;

const COPY: Record<LimitField, { label: string; hint: string }> = {
  maxOpenComplaints: {
    label: 'Open complaints per resident',
    hint: 'How many complaints one resident may have open at once. One more is refused until one of theirs is closed.',
  },
  lostFoundExpiryDays: {
    label: 'Days a lost or found post stays up',
    hint: 'After that it leaves the board by itself. A found item nobody came for is still at the office and may still be handed over.',
  },
  lendingExpiryDays: { label: 'Days a lending post stays up', hint: 'After that it leaves the board by itself.' },
  maxOpenPosts: { label: 'Posts on the boards per resident', hint: 'How many posts one resident may have on the two boards at once.' },
  maxNewConversationsPerDay: {
    label: 'New conversations per resident, in 24 hours',
    hint: 'How many neighbours one resident may write to about their posts in a day. Keeps the boards from being used to message everyone.',
  },
};

/**
 * The compound's limits for complaints and the boards (ADR 0042). Only what
 * changed is sent; a change applies from now on, and posts already up keep
 * the day they were given.
 */
export function Limits() {
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
      toast.show('Limits saved.');
    },
  });

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;
  const field = (key: LimitField) => {
    const { min, max } = LIMIT_RANGES[key];
    return (
      <Field
        label={COPY[key].label}
        hint={`${COPY[key].hint} From ${min} to ${max}.`}
        error={fieldError(save.error, key) ?? (validLimit(key, form[key]) ? undefined : `A whole number from ${min} to ${max}.`)}
      >
        {(p) => <Input {...p} type="number" min={min} max={max} step={1} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
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
        <CardHeader title="Complaints" />
        <CardBody>
          <div className="form">{field('maxOpenComplaints')}</div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title="Boards" />
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
            Discard
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            Save limits
          </Button>
        </span>
      </div>
    </form>
  );
}
