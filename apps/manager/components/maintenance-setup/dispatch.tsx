'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { countRows, fetchers, keys, type DispatchSettings } from '@/lib/queries';
import ar from '@/messages/ar/ms-dispatch';
import en from '@/messages/en/ms-dispatch';
import { useNameOf } from './names';

const NUMBERS = [
  { key: 'weightAssigned', hint: true, min: 0 },
  { key: 'weightInProgress', hint: true, min: 0 },
  { key: 'weightOnHold', hint: true, min: 0 },
  { key: 'multiplierNormal', hint: true, min: 0.1 },
  { key: 'multiplierUrgent', hint: false, min: 0.1 },
  { key: 'multiplierEmergency', hint: false, min: 0.1 },
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const nameOf = useNameOf();
  const toast = useToast();
  const { can } = usePermissions();
  const settings = useQuery({ queryKey: keys.dispatchSettings, queryFn: fetchers.dispatchSettings });
  // What turning it on would meet: read only by a role that may dispatch.
  const dispatcher = can('tickets.dispatch');
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, enabled: dispatcher, retry: false });
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  const waiting = useQuery({
    queryKey: [...keys.tickets({ status: 'new' }), 'waiting-count'],
    queryFn: () => countRows((cursor) => fetchers.tickets({ status: 'new' }, cursor, 100)),
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
        toast.show(next.autoDispatchEnabled ? t('turnedOn') : t('turnedOff'));
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
      toast.show(t('weightsSaved'));
    },
  });

  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;

  const techs = technicians.data?.data;
  const available = techs?.filter((x) => x.availability.state === 'available') ?? [];
  const unskilled = techs?.filter((x) => x.specialties.length === 0) ?? [];
  const bare = (categories.data?.data ?? []).filter((c) => c.active && c.specialtyIds.length === 0);
  const queue = waiting.data ? (waiting.data.more ? `${waiting.data.count}+` : String(waiting.data.count)) : null;
  const queueCount = waiting.data?.count ?? 0;

  return (
    <div className="grid grid--2" style={{ alignItems: 'start' }}>
      <Card flush>
        <CardHeader title={t('automatic')} actions={<Badge tone={on ? 'green' : 'beige'}>{on ? t('on') : t('off')}</Badge>} />
        <CardBody>
          <div className="stack">
            <p>{on ? t('onBody') : t('offBody')}</p>
            {techs ? (
              <ul className="list">
                <li className="list__item" style={{ paddingInline: 0 }}>
                  <span className="list__text">{t('techsAvailable', { available: available.length, total: techs.length })}</span>
                </li>
                {unskilled.length ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">{t('techsUnskilled', { n: unskilled.length })}</span>
                  </li>
                ) : null}
                {bare.length ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">{t('categoriesBare', { n: bare.length, names: fmt.list(bare.map(nameOf)) })}</span>
                  </li>
                ) : null}
                {queue !== null ? (
                  <li className="list__item" style={{ paddingInline: 0 }}>
                    <span className="list__text">{t('queue', { queue, n: queueCount })}</span>
                  </li>
                ) : null}
              </ul>
            ) : null}
            <ErrorAlert error={toggle.error} />
            <span>
              <Button variant={on ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
                {on ? t('turnOff') : t('turnOn')}
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
          <CardHeader title={t('weights')} />
          <CardBody>
            <div className="form">
              <p className="t-secondary">{t('weightsHint')}</p>
              <div className="form__row">
                {NUMBERS.map((n) => (
                  <Field key={n.key} label={t(`weight.${n.key}`)} hint={n.hint ? t(`weightHint.${n.key}`) : undefined} error={fieldError(save.error, n.key)}>
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
            {t('discard')}
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            {t('saveWeights')}
          </Button>
        </span>
      </form>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          toggle.reset();
        }}
        title={on ? t('offTitle') : t('onTitle')}
        description={
          on ? (
            t('confirmOffBody')
          ) : (
            <>
              {t('confirmOnBody', { now: queue !== null ? t('nowSuffix', { queue }) : '' })}
              {techs && available.length === 0 ? ` ${t('noTechNow')}` : ''}
            </>
          )
        }
        confirmLabel={on ? t('turnOff') : t('turnOnAssign')}
        pending={toggle.isPending}
        error={
          <div className="stack stack--sm">
            {!on && (unskilled.length > 0 || bare.length > 0) ? (
              <Alert tone="warn">
                {t('checkFirst', {
                  parts: fmt.list([
                    ...(unskilled.length ? [t('unskilledPart', { n: unskilled.length })] : []),
                    ...(bare.length ? [t('barePart', { n: bare.length })] : []),
                  ]),
                })}
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
