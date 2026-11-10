'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT, type Translate } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Outage } from '@/lib/queries';
import ar from '@/messages/ar/outages';
import en from '@/messages/en/outages';

/** A datetime-local value as an instant with its offset. */
const instant = (local: string) => new Date(local).toISOString();
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function statusOf(t: Translate<typeof en>, o: Outage, now = Date.now()): string {
  if (o.cancelledAt) return t('state.cancelled');
  if (o.endedAt) return t('state.ended');
  if (Date.parse(o.startsAt) <= now) return t('state.going');
  return o.notifiedAt ? t('state.told') : t('state.toBeTold');
}

function OutageDialog({ outage, onClose }: { outage: Outage | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const soon = new Date(Date.now() + 3 * 24 * 3_600_000);
  const [f, setF] = useState({
    kind: (outage?.kind ?? 'water') as (typeof REASON_CODES.outageKind)[number],
    planned: outage ? outage.planned : true,
    buildings: outage?.buildings.join(', ') ?? '',
    startsAt: local(outage ? new Date(outage.startsAt) : soon),
    endsAt: local(outage ? new Date(outage.endsAt) : new Date(soon.getTime() + 4 * 3_600_000)),
    note: outage?.note ?? '',
  });
  const buildings = f.buildings
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b !== '');
  const save = useAction(
    () =>
      outage
        ? unwrap(
            api.PATCH('/api/v1/maintenance/outages/{id}', {
              params: { path: { id: outage.id } },
              body: {
                scope: buildings.length ? 'buildings' : 'compound',
                buildings,
                ...(instant(f.startsAt) !== outage.startsAt ? { startsAt: instant(f.startsAt) } : {}),
                endsAt: instant(f.endsAt),
                note: f.note.trim() || null,
              },
            }),
          )
        : unwrap(
            api.POST('/api/v1/maintenance/outages', {
              body: {
                kind: f.kind,
                planned: f.planned,
                scope: buildings.length ? 'buildings' : 'compound',
                buildings,
                startsAt: instant(f.startsAt),
                endsAt: instant(f.endsAt),
                ...(f.note.trim() ? { note: f.note.trim() } : {}),
              },
            }),
          ),
    {
      invalidate: [keys.outages],
      onDone: (o) => {
        toast.show(o.notifiedAt ? t('savedTold') : t('savedLater'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={outage ? t('changeTitle') : t('newTitle')}
      description={t('dialogDescription')}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        {outage ? null : (
          <div className="form__row">
            <Field label={t('whatIsCut')} error={fieldError(save.error, 'kind')}>
              {(p) => (
                <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>
                  {REASON_CODES.outageKind.map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('planned')}>
              {(p) => (
                <Select {...p} value={f.planned ? 'yes' : 'no'} onChange={(e) => setF({ ...f, planned: e.target.value === 'yes' })}>
                  <option value="yes">{t('plannedYes')}</option>
                  <option value="no">{t('plannedNo')}</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        <Field label={t('buildings')} hint={t('buildingsHint')} error={fieldError(save.error, 'buildings')}>
          {(p) => <Input {...p} value={f.buildings} onChange={(e) => setF({ ...f, buildings: e.target.value })} />}
        </Field>
        <div className="form__row">
          <Field label={t('from')} error={fieldError(save.error, 'startsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />}
          </Field>
          <Field label={t('to')} error={fieldError(save.error, 'endsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />}
          </Field>
        </div>
        <Field label={t('residentsShould')} error={fieldError(save.error, 'note')}>
          {(p) => <Input {...p} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Utility outages (ADR 0066), told to the residents of their buildings. */
export default function OutagesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const manage = can('energy.manage');
  const [editing, setEditing] = useState<Outage | null | 'new'>(null);
  const [cancelling, setCancelling] = useState<Outage | null>(null);
  const list = useCursorList(keys.outages, (c) => fetchers.outages(c), { enabled: can('energy.read') });
  const end = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/outages/{id}/end', { params: { path: { id } } })),
    { invalidate: [keys.outages], onDone: () => toast.show(t('ended')) },
  );
  const cancel = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/outages/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.outages],
      onDone: () => {
        toast.show(t('calledOff'));
        setCancelling(null);
      },
    },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('newOutage')}
            </Button>
          ) : null
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Outage>
            rows={list.rows}
            rowKey={(o) => o.id}
            empty={t('empty')}
            columns={[
              { key: 'k', header: t('col.what'), cell: (o) => label(o.kind) },
              { key: 'b', header: t('col.where'), cell: (o) => (o.buildings.length ? f.list(o.buildings) : t('theCompound')) },
              { key: 'f', header: t('col.from'), cell: (o) => f.dateTime(o.startsAt) },
              { key: 't', header: t('col.to'), cell: (o) => f.dateTime(o.endsAt) },
              { key: 's', header: t('col.status'), cell: (o) => statusOf(t, o) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (o) =>
                  manage && !o.endedAt && !o.cancelledAt ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setEditing(o)}>
                        {t('change')}
                      </Button>
                      {Date.parse(o.startsAt) <= Date.now() ? (
                        <Button size="sm" loading={end.isPending} onClick={() => end.mutate(o.id)}>
                          {t('end')}
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setCancelling(o)}>
                          {t('callOff')}
                        </Button>
                      )}
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {editing ? <OutageDialog outage={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('callOffTitle')}
        codes={REASON_CODES.outageCancel}
        confirmLabel={t('callOff')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error ?? end.error} />}
        onConfirm={(code) => cancelling && cancel.mutate({ id: cancelling.id, reasonCode: code })}
      />
    </>
  );
}
