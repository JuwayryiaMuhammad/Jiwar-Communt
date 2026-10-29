'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Outage } from '@/lib/queries';

/** A datetime-local value as an instant with its offset. */
const instant = (local: string) => new Date(local).toISOString();
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function statusOf(o: Outage, now = Date.now()): string {
  if (o.cancelledAt) return 'Cancelled';
  if (o.endedAt) return 'Ended';
  if (Date.parse(o.startsAt) <= now) return 'Going on';
  return o.notifiedAt ? 'Told' : 'To be told';
}

function OutageDialog({ outage, onClose }: { outage: Outage | null; onClose: () => void }) {
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
        toast.show(o.notifiedAt ? 'Saved; its residents are told.' : 'Saved; its residents are told 48 hours before.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={outage ? 'Change the outage' : 'New outage'}
      description="Its residents are told 48 hours before it starts, or at once when it starts sooner or was not planned. A new start is told again, once."
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        {outage ? null : (
          <div className="form__row">
            <Field label="What is cut" error={fieldError(save.error, 'kind')}>
              {(p) => (
                <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>
                  {REASON_CODES.outageKind.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Planned">
              {(p) => (
                <Select {...p} value={f.planned ? 'yes' : 'no'} onChange={(e) => setF({ ...f, planned: e.target.value === 'yes' })}>
                  <option value="yes">Planned: told 48 hours ahead</option>
                  <option value="no">Not planned: told now</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        <Field label="Buildings" hint="Separated by commas. Empty: the whole compound." error={fieldError(save.error, 'buildings')}>
          {(p) => <Input {...p} value={f.buildings} onChange={(e) => setF({ ...f, buildings: e.target.value })} />}
        </Field>
        <div className="form__row">
          <Field label="From" error={fieldError(save.error, 'startsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />}
          </Field>
          <Field label="To" error={fieldError(save.error, 'endsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />}
          </Field>
        </div>
        <Field label="What residents should do" error={fieldError(save.error, 'note')}>
          {(p) => <Input {...p} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Utility outages (ADR 0066), told to the residents of their buildings. */
export default function OutagesPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const manage = can('energy.manage');
  const [editing, setEditing] = useState<Outage | null | 'new'>(null);
  const [cancelling, setCancelling] = useState<Outage | null>(null);
  const list = useCursorList(keys.outages, (c) => fetchers.outages(c), { enabled: can('energy.read') });
  const end = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/outages/{id}/end', { params: { path: { id } } })),
    { invalidate: [keys.outages], onDone: () => toast.show('Ended; those told are told.') },
  );
  const cancel = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/outages/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.outages],
      onDone: () => {
        toast.show('Called off; those told are told.');
        setCancelling(null);
      },
    },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title="Outages" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Outages"
        description="Water, electricity and gas cut off, told to the residents of their buildings."
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New outage
            </Button>
          ) : null
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Outage>
            rows={list.rows}
            rowKey={(o) => o.id}
            empty="No outage"
            columns={[
              { key: 'k', header: 'What', cell: (o) => humanize(o.kind) },
              { key: 'b', header: 'Where', cell: (o) => (o.buildings.length ? o.buildings.join(', ') : 'The compound') },
              { key: 'f', header: 'From', cell: (o) => formatDateTime(o.startsAt) },
              { key: 't', header: 'To', cell: (o) => formatDateTime(o.endsAt) },
              { key: 's', header: 'Status', cell: (o) => statusOf(o) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (o) =>
                  manage && !o.endedAt && !o.cancelledAt ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setEditing(o)}>
                        Change
                      </Button>
                      {Date.parse(o.startsAt) <= Date.now() ? (
                        <Button size="sm" loading={end.isPending} onClick={() => end.mutate(o.id)}>
                          End
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setCancelling(o)}>
                          Call off
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
        title="Call the outage off"
        codes={REASON_CODES.outageCancel}
        confirmLabel="Call off"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error ?? end.error} />}
        onConfirm={(c) => cancelling && cancel.mutate({ id: cancelling.id, reasonCode: c })}
      />
    </>
  );
}
