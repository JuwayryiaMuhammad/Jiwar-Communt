'use client';

import { fieldError, formatDateTime, humanize, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Parcel, type ParcelCarrier, type ParcelFilters, type ParcelStatus } from '@/lib/queries';

const CARRIERS: ParcelCarrier[] = ['aramex', 'dhl', 'fedex', 'ups', 'bosta', 'mylerz', 'egypt_post', 'amazon', 'noon', 'jumia', 'talabat', 'other'];
const CARRIER_TEXT: Partial<Record<ParcelCarrier, string>> = { dhl: 'DHL', ups: 'UPS', fedex: 'FedEx', egypt_post: 'Egypt Post' };
const carrier = (c: ParcelCarrier) => CARRIER_TEXT[c] ?? humanize(c);
/** The API's `rejected` is the unit refusing the parcel: one word for it everywhere. */
function ParcelStatusBadge({ status }: { status: ParcelStatus }) {
  return status === 'rejected' ? <Badge tone="error">Refused</Badge> : <StatusBadge status={status} />;
}
const VIEWS = ['held', 'handed_over', 'rejected', 'returned', 'all'] as const;
type View = (typeof VIEWS)[number];

function ParcelDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const parcel = useQuery({ queryKey: keys.parcel(id), queryFn: () => fetchers.parcel(id) });
  const p = parcel.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={p ? `Parcel ${p.number} · unit ${p.unitCode}` : 'Parcel'}
      description={p ? `${carrier(p.carrier)} · ${p.pieces} piece${p.pieces === 1 ? '' : 's'}` : undefined}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <QueryState query={parcel} rows={4}>
        {p ? (
          <div className="stack">
            <dl className="dl">
              <dt>Status</dt>
              <dd>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <ParcelStatusBadge status={p.status} />
                  {p.status === 'held' ? <span className="t-secondary">{p.heldDays} day{p.heldDays === 1 ? '' : 's'} at the gate</span> : null}
                  {p.unclaimable ? <Badge tone="terracotta">Nobody can claim it</Badge> : null}
                </span>
              </dd>
              <dt>Received</dt>
              <dd>{formatDateTime(p.receivedAt)}</dd>
              {p.handedOverAt ? (
                <>
                  <dt>Handed over</dt>
                  <dd>{formatDateTime(p.handedOverAt)}</dd>
                </>
              ) : null}
              {p.rejectedAt ? (
                <>
                  <dt>Refused by the unit</dt>
                  <dd>
                    {formatDateTime(p.rejectedAt)}
                    {p.rejectReason ? ` · ${humanize(p.rejectReason)}` : ''}
                  </dd>
                </>
              ) : null}
              {p.returnedAt ? (
                <>
                  <dt>Returned to the carrier</dt>
                  <dd>
                    {formatDateTime(p.returnedAt)}
                    {p.returnReason ? ` · ${humanize(p.returnReason)}` : ''}
                  </dd>
                </>
              ) : null}
              <dt>Reminders</dt>
              <dd>
                {p.reminded ? 'The unit was reminded' : 'No reminder yet'}
                {p.heldLongNotified ? ' · management was told it is held long' : ''}
              </dd>
            </dl>
            <div className="stack stack--sm">
              <strong>What happened</strong>
              <ol className="timeline" style={{ padding: 0 }}>
                {p.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className={`timeline__item${e.kind === 'rejected' || e.kind === 'returned' ? ' timeline__item--warn' : ''}`}>
                    <div className="timeline__title">{humanize(e.kind)}</div>
                    <div className="timeline__meta">
                      {formatDateTime(e.at)} · by the {e.actorSide}
                      {e.method ? ` · ${humanize(e.method).toLowerCase()}` : ''}
                      {e.reasonCode ? ` · ${humanize(e.reasonCode).toLowerCase()}` : ''}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <p className="t-secondary">
              Management sees no name here: not the one on the label, nor who collected it. The unit's residents see their own parcels in the app.
            </p>
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/** How long a parcel waits before its residents, then management, are told. */
function HoldingPeriodsDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.parcelSettings, queryFn: fetchers.parcelSettings });
  const [reminder, setReminder] = useState('');
  const [manager, setManager] = useState('');
  useEffect(() => {
    if (settings.data) {
      setReminder(String(settings.data.parcelReminderDays));
      setManager(String(settings.data.parcelManagerDays));
    }
  }, [settings.data]);
  const saved = settings.data;
  const changes = saved
    ? {
        ...(Number(reminder) !== saved.parcelReminderDays ? { parcelReminderDays: Number(reminder) } : {}),
        ...(Number(manager) !== saved.parcelManagerDays ? { parcelManagerDays: Number(manager) } : {}),
      }
    : {};
  const dirty = Object.keys(changes).length > 0;
  // The one cross-field rule, said before the API has to.
  const inverted = reminder !== '' && manager !== '' && Number(manager) <= Number(reminder);
  const save = useAction(() => unwrap(api.PATCH('/api/v1/parcel-settings', { body: changes })), {
    invalidate: [keys.parcelSettings],
    onDone: () => {
      toast.show('Holding periods saved.');
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Holding periods"
      description="They apply to parcels that have not passed the mark yet; each notice is sent once per parcel."
      onSubmit={() => dirty && !inverted && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || inverted}>
            Save
          </Button>
        </>
      }
    >
      <QueryState query={settings} rows={2}>
        <div className="form">
          <Field label="Remind the residents after (days)" hint="1 to 30." error={fieldError(save.error, 'parcelReminderDays')}>
            {(p) => <Input {...p} type="number" min={1} max={30} value={reminder} onChange={(e) => setReminder(e.target.value)} />}
          </Field>
          <Field
            label="Tell management after (days)"
            hint="2 to 90. From then an unclaimed parcel may be returned to the carrier."
            error={fieldError(save.error, 'parcelManagerDays') ?? (inverted ? 'More than the reminder.' : undefined)}
          >
            {(p) => <Input {...p} type="number" min={2} max={90} value={manager} onChange={(e) => setManager(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

/**
 * Every parcel at the gate (ADR 0035), without names. Guards receive and
 * hand over; this is management's read of what is waiting and for how long.
 */
export default function ParcelsPage() {
  const [view, setView] = useState<View>('held');
  const [carrierFilter, setCarrierFilter] = useState<ParcelCarrier | ''>('');
  const [unitCode, setUnitCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const filters: ParcelFilters = { status: view === 'all' ? '' : (view as ParcelStatus), carrier: carrierFilter, unitCode: unitCode.trim() };
  const { ready, can } = usePermissions();
  const allowed = can('parcels.manage');
  const list = useCursorList(keys.parcels(filters), (c) => fetchers.parcels(filters, c), { refetchInterval: 120_000, enabled: allowed });

  // The list and the holding periods both need `parcels.manage`.
  if (ready && !allowed) {
    return (
      <>
        <PageHeader title="Parcels" />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Parcels"
        description="What the gate is holding for the units, and what became of the rest. No names: the guards and the residents handle the handover."
        actions={<Button onClick={() => setSettings(true)}>Holding periods</Button>}
      />
      <div className="toolbar">
        <Segmented<View>
          label="Parcels shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'held', label: 'At the gate' },
            { value: 'handed_over', label: 'Handed over' },
            { value: 'rejected', label: 'Refused' },
            { value: 'returned', label: 'Returned' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Carrier">
          {(p) => (
            <Select {...p} value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value as ParcelCarrier | '')}>
              <option value="">Any carrier</option>
              {CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {carrier(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Unit code">
          {(p) => <Input {...p} placeholder="e.g. A-101" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Parcel>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={view === 'held' ? 'The gate is holding no parcel' : 'No parcel matches'}
            emptyHint={view === 'held' ? 'A guard records each parcel when the carrier leaves it at the gate.' : undefined}
            columns={[
              {
                key: 'number',
                header: 'Parcel',
                cell: (p) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(p.id)}>
                    {p.number}
                  </Button>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (p) => p.unitCode },
              { key: 'carrier', header: 'Carrier', cell: (p) => carrier(p.carrier) },
              { key: 'pieces', header: 'Pieces', cell: (p) => <span className="t-num">{p.pieces}</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (p) => (
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <ParcelStatusBadge status={p.status} />
                    {p.status === 'held' && p.heldLongNotified ? <Badge tone="error">Held long</Badge> : null}
                    {p.status === 'held' && p.reminded && !p.heldLongNotified ? <Badge plain>Reminded</Badge> : null}
                    {p.unclaimable ? <Badge tone="terracotta">Unclaimable</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'held',
                header: 'At the gate',
                cell: (p) => (p.status === 'held' ? <span className="t-num">{p.heldDays} d</span> : <span className="t-secondary">—</span>),
              },
              {
                key: 'received',
                header: 'Received',
                cell: (p) => (
                  <span title={formatDateTime(p.receivedAt)} style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(p.receivedAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ParcelDialog id={open} onClose={() => setOpen(null)} /> : null}
      {settings ? <HoldingPeriodsDialog onClose={() => setSettings(false)} /> : null}
    </>
  );
}
