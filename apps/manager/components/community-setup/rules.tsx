'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/community-setup';
import en from '@/messages/en/community-setup';

const GUESTS = { min: 0, max: 20 };
const valid = (value: string) => {
  const n = Number(value);
  return value !== '' && Number.isInteger(n) && n >= GUESTS.min && n <= GUESTS.max;
};

/** How many guests one "going" answer to an event may bring (ADR 0040). */
export function CommunityRules() {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.communitySettings, queryFn: fetchers.communitySettings });
  const [guests, setGuests] = useState<string | null>(null);
  // Seed once: a background refetch must not wipe an unsaved edit.
  useEffect(() => {
    if (settings.data && guests === null) setGuests(String(settings.data.eventMaxGuests));
  }, [settings.data, guests]);

  const save = useAction(() => unwrap(api.PATCH('/api/v1/community/settings', { body: { eventMaxGuests: Number(guests) } })), {
    invalidate: [keys.communitySettings],
    onDone: (saved) => {
      setGuests(String(saved.eventMaxGuests));
      toast.show(t('rulesSaved'));
    },
  });
  const changed = settings.data !== undefined && guests !== null && Number(guests) !== settings.data.eventMaxGuests;

  return (
    <Card>
      <CardHeader title={t('events')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form" style={{ maxWidth: 420 }}>
            <Field
              label={t('guests')}
              hint={t('guestsHint')}
              error={
                fieldError(save.error, 'eventMaxGuests') ??
                (guests !== null && !valid(guests) ? t('guestsInvalid', { min: GUESTS.min, max: GUESTS.max }) : undefined)
              }
            >
              {(p) => (
                <Input {...p} type="number" min={GUESTS.min} max={GUESTS.max} step={1} value={guests ?? ''} onChange={(e) => setGuests(e.target.value)} />
              )}
            </Field>
            <ErrorAlert error={save.error} />
            <div className="row">
              <Button variant="primary" loading={save.isPending} disabled={!changed || !valid(guests ?? '')} onClick={() => save.mutate()}>
                {c('save')}
              </Button>
            </div>
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}
