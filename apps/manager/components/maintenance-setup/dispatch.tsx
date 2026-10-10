'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DispatchSettings } from '@/lib/queries';

const NUMBERS = [
  { key: 'weightAssigned', label: 'Assigned', hint: 'A ticket the technician has not started.', min: 0 },
  { key: 'weightInProgress', label: 'In progress', hint: 'A ticket being worked on.', min: 0 },
  { key: 'weightOnHold', label: 'On hold', hint: '0: a ticket waiting for parts or the resident takes no time now.', min: 0 },
  { key: 'multiplierNormal', label: 'Normal multiplier', hint: 'Times the status weight, for a normal-priority ticket.', min: 0.1 },
  { key: 'multiplierUrgent', label: 'Urgent multiplier', hint: '', min: 0.1 },
  { key: 'multiplierEmergency', label: 'Emergency multiplier', hint: '', min: 0.1 },
] as const;
type NumberKey = (typeof NUMBERS)[number]['key'];
type Form = Record<NumberKey, string>;
const toForm = (s: DispatchSettings): Form => Object.fromEntries(NUMBERS.map((n) => [n.key, String(s[n.key])])) as Form;

/**
 * Automatic dispatch (ADR 0033). The switch is confirmed on its own, because
 * turning it on acts at once on the tickets waiting in the queue; the
 * workload weights are an ordinary form.
 */
export function Dispatch() {
  const toast = useToast();
  const { can } = usePermissions();
  const settings = useQuery({ queryKey: keys.dispatchSettings, queryFn: fetchers.dispatchSettings });
  // What turning it on would meet: read only by a role that may dispatch.
  const dispatcher = can('tickets.dispatch');
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, enabled: dispatcher, retry: false });
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  const waiting = useQuery({
    queryKey: keys.tickets({ status: 'new' }),
    queryFn: () => fetchers.tickets({ status: 'new' }, undefined, 100),
    enabled: dispatcher,
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const saved = settings.data;
  const on = saved?.autoDispatchEnabled === true;
  const toggle = useAction(
    () => unwrap(api.PATCH('/api/v1/maintenance/dispatch-settings', { body: { autoDispatchEnabled: !on } })),
    {
      invalidate: [keys.dispatchSettings, keys.ticketsAll, keys.technicians],
      onDone: (next) => {
        toast.show(
          next.autoDispatchEnabled
            ? 'Automatic dispatch is on. The waiting tickets are being offered now.'
            : 'Automatic dispatch is off. New tickets wait for a dispatcher.',
        );
        setConfirming(false);
      },
    },
  );
  const changes =
    saved && form ? Object.fromEntries(NUMBERS.filter((n) => Number(form[n.key]) !== saved[n.key]).map((n) => [n.key, Number(form[n.key])])) : {};
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/maintenance/dispatch-settings', { body: changes })), {
    invalidate: [keys.dispatchSettings, keys.technicians],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show('Workload weights saved.');
    },
  });

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;

  const techs = technicians.data?.data;
  const available = techs?.filter((t) => t.availability.state === 'available') ?? [];
  const unskilled = techs?.filter((t) => t.specialties.length === 0) ?? [];
  const bare = (categories.data?.data ?? []).filter((c) => c.active && c.specialtyIds.length === 0);
  const queue = waiting.data ? (waiting.data.nextCursor ? `${waiting.data.data.length}+` : String(waiting.data.data.length)) : null;

  return (
    <div className="grid grid--2" style={{ alignItems: 'start' }}>
      <Card flush>
        <CardHeader title="Automatic dispatch" actions={<Badge tone={on ? 'green' : 'beige'}>{on ? 'On' : 'Off'}</Badge>} />
        <CardBody>
          <div className="stack">
            <p>
              {on
                ? 'A new ticket goes to the least loaded available technician with a specialty its category needs. A ticket nobody qualifies for stays in the queue, and the dispatchers are told.'
                : 'Every ticket waits in the queue until a dispatcher assigns it. "Auto-assign" on a ticket still tries the engine for that one ticket.'}
            </p>
            {techs ? (
              <ul className="list">
                <li className="list__item" style={{ paddingInline: 0 }}>
                  <span className="list__text">
                    {available.length} of {techs.length} technician{techs.length === 1 ? '' : 's'} available now
                  </span>
                </li>
                {unskilled.length ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">
                      {unskilled.length} technician{unskilled.length === 1 ? ' has' : 's have'} no specialty and will be offered nothing
                    </span>
                  </li>
                ) : null}
                {bare.length ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">
                      {bare.length} categor{bare.length === 1 ? 'y has' : 'ies have'} no specialty, so {bare.length === 1 ? 'its' : 'their'} tickets
                      always wait for a dispatcher: {bare.map((c) => c.nameEn).join(', ')}
                    </span>
                  </li>
                ) : null}
                {queue !== null ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">
                      {queue} ticket{queue === '1' ? '' : 's'} waiting in the queue
                    </span>
                  </li>
                ) : null}
              </ul>
            ) : null}
            <ErrorAlert error={toggle.error} />
            <span>
              <Button variant={on ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
                {on ? 'Turn off' : 'Turn on'}
              </Button>
            </span>
          </div>
        </CardBody>
      </Card>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <Card flush>
          <CardHeader title="Workload weights" />
          <CardBody>
            <div className="form">
              <p className="t-secondary">
                A technician's workload is the sum over their open tickets of the status weight times the priority multiplier. Automatic dispatch
                picks the lowest; the Technicians tab shows it.
              </p>
              <div className="form__row">
                {NUMBERS.map((n) => (
                  <Field key={n.key} label={n.label} hint={n.hint || undefined} error={fieldError(save.error, n.key)}>
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        step="0.01"
                        min={n.min}
                        max={100}
                        value={form[n.key]}
                        onChange={(e) => setForm({ ...form, [n.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
        <ErrorAlert error={save.error} />
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          <Button disabled={!dirty} onClick={() => setForm(toForm(saved))}>
            Discard
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            Save weights
          </Button>
        </span>
      </form>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          toggle.reset();
        }}
        title={on ? 'Turn automatic dispatch off?' : 'Turn automatic dispatch on?'}
        description={
          on ? (
            'New tickets will wait in the queue for a dispatcher. Tickets already assigned stay with their technicians.'
          ) : (
            <>
              This acts at once: up to 50 of the tickets waiting in the queue
              {queue !== null ? ` (${queue} now)` : ''} are assigned right away, and every new ticket from now on. Technicians are notified of
              each one.
              {techs && available.length === 0 ? ' No technician is available now, so nothing would be assigned yet.' : ''}
            </>
          )
        }
        confirmLabel={on ? 'Turn off' : 'Turn on and assign the queue'}
        danger={!on}
        pending={toggle.isPending}
        error={
          <div className="stack stack--sm">
            {!on && (unskilled.length > 0 || bare.length > 0) ? (
              <Alert tone="warn">
                Check the specialties first: {unskilled.length ? `${unskilled.length} technician${unskilled.length === 1 ? '' : 's'} without one` : ''}
                {unskilled.length && bare.length ? ', ' : ''}
                {bare.length ? `${bare.length} categor${bare.length === 1 ? 'y' : 'ies'} without one` : ''}. Their tickets will keep waiting.
              </Alert>
            ) : null}
            <ErrorAlert error={toggle.error} />
          </div>
        }
        onConfirm={() => toggle.mutate()}
      />
    </div>
  );
}
