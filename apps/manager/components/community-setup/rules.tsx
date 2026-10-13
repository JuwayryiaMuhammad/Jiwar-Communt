'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';

const GUESTS = { min: 0, max: 20 };
const valid = (value: string) => {
  const n = Number(value);
  return value !== '' && Number.isInteger(n) && n >= GUESTS.min && n <= GUESTS.max;
};

/** How many guests one "going" answer to an event may bring (ADR 0040). */
export function CommunityRules() {
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
      toast.show('The rules are saved.');
    },
  });
  const changed = settings.data !== undefined && guests !== null && Number(guests) !== settings.data.eventMaxGuests;

  return (
    <Card>
      <CardHeader title="Events" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form" style={{ maxWidth: 420 }}>
            <Field
              label="Guests per answer, at most"
              hint="How many people a resident who is going may bring. Guests take seats like anyone else. A change applies to answers given from now on."
              error={fieldError(save.error, 'eventMaxGuests') ?? (guests !== null && !valid(guests) ? `A whole number from ${GUESTS.min} to ${GUESTS.max}.` : undefined)}
            >
              {(p) => (
                <Input {...p} type="number" min={GUESTS.min} max={GUESTS.max} step={1} value={guests ?? ''} onChange={(e) => setGuests(e.target.value)} />
              )}
            </Field>
            <ErrorAlert error={save.error} />
            <div className="row">
              <Button variant="primary" loading={save.isPending} disabled={!changed || !valid(guests ?? '')} onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}
