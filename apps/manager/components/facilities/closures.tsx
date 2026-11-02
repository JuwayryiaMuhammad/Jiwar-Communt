'use client';

import { fieldError, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { slotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { fetchers, keys, type Facility, type FacilityClosure } from '@/lib/queries';
import { fromLocalInput } from './logic';

type ClosurePreview = {
  bookings: { id: string; unitCode: string; startsAt: string; endsAt: string; charge: { amount: string; status: string; outcome: string } | null }[];
  invoicesCredited: string;
  unitCredit: string;
  previewToken: string;
};

/**
 * Closing a facility (ADR 0044) after its preview (ADR 0084): the bookings
 * it cancels and what their fees become — an unpaid invoice credited, a paid
 * fee the unit's credit. The closure applies exactly what was previewed; if
 * the bookings changed meanwhile the server refuses and the preview is read
 * again.
 */
function NewClosureDialog({ facility, onClose }: { facility: Facility; onClose: () => void }) {
  const toast = useToast();
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [seen, setSeen] = useState<ClosurePreview | null>(null);
  const from = fromLocalInput(startsAt);
  const to = fromLocalInput(endsAt);
  const look = useAction(
    () =>
      unwrap(
        api.GET('/api/v1/staff/facilities/{id}/closure-preview', {
          params: { path: { id: facility.id }, query: { startsAt: from!, endsAt: to! } },
        }),
      ) as Promise<ClosurePreview>,
    { onDone: (p) => setSeen(p) },
  );
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/facilities/{id}/closures', {
          params: { path: { id: facility.id } },
          body: { startsAt: from!, endsAt: to!, reasonCode, previewToken: seen!.previewToken },
        }),
      ),
    {
      invalidate: [keys.facilitiesAll, keys.bookingsAll],
      onDone: (c) => {
        toast.show(
          c.cancelledBookings
            ? `${facility.nameEn} is closed. ${c.cancelledBookings} booking${c.cancelledBookings === 1 ? ' was' : 's were'} cancelled and the bookers told.`
            : `${facility.nameEn} is closed. No booking was affected.`,
        );
        onClose();
      },
    },
  );
  const window = from !== null && to !== null && to > from;
  const ready = window && reasonCode !== '' && seen !== null;
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setSeen(null);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Close ${facility.nameEn}`}
      description="Preview first: every booking that holds a place in this time and has not started is cancelled and its booker told; a fee is credited — an unpaid invoice cancelled, a paid one to the unit’s credit. A booking under way is left as it is."
      onSubmit={() => (ready ? save.mutate() : window && look.mutate())}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {seen ? (
            <>
              {/* The bookings may have changed meanwhile (FACILITY_CLOSURE_PREVIEW_STALE). */}
              <Button loading={look.isPending} onClick={() => look.mutate()}>
                Preview again
              </Button>
              <Button type="submit" variant="danger" loading={save.isPending} disabled={!ready}>
                Close the facility
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" loading={look.isPending} disabled={!window}>
              Preview
            </Button>
          )}
        </>
      }
    >
      <div className="form">
        <Field label="From" error={fieldError(save.error ?? look.error, 'startsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => edit(setStartsAt)(e.target.value)} />}
        </Field>
        <Field
          label="Until"
          error={fieldError(save.error ?? look.error, 'endsAt') ?? (from && to && to <= from ? 'After the start.' : undefined)}
        >
          {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => edit(setEndsAt)(e.target.value)} />}
        </Field>
        <Field label="Reason" error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.facilityClosure.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {seen ? (
          <Card flush>
            <DataTable<ClosurePreview['bookings'][number]>
              rows={seen.bookings}
              rowKey={(b) => b.id}
              empty="No booking is affected"
              emptyHint="Nothing is cancelled or credited."
              columns={[
                { key: 'when', header: 'When', cell: (b) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(b.startsAt, b.endsAt)}</span> },
                { key: 'unit', header: 'Unit', cell: (b) => b.unitCode },
                {
                  key: 'fee',
                  header: 'Fee',
                  cell: (b) =>
                    b.charge ? (
                      <Badge tone={b.charge.outcome === 'unit_credit' ? 'terracotta' : 'beige'}>
                        {b.charge.amount} · {b.charge.outcome === 'unit_credit' ? 'to the unit’s credit' : 'invoice credited'}
                      </Badge>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
            <p className="muted" style={{ padding: '0 1rem 1rem' }}>
              Invoices credited: {seen.invoicesCredited} · Back to the units’ credit: {seen.unitCredit}
            </p>
          </Card>
        ) : null}
        <ErrorAlert error={save.error ?? look.error} />
      </div>
    </Dialog>
  );
}

/**
 * A facility's closures (ADR 0044), latest first. Lifting one opens its
 * time to bookings again; what it cancelled stays cancelled.
 */
export function Closures({ facility, canManage }: { facility: Facility; canManage: boolean }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [lifting, setLifting] = useState<FacilityClosure | null>(null);
  const list = useCursorList(keys.facilityClosures(facility.id), (c) => fetchers.facilityClosures(facility.id, c));
  const lift = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/facility-closures/{id}/lift', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.facilitiesAll],
      onDone: () => {
        toast.show('The closure is lifted.');
        setLifting(null);
      },
    },
  );

  return (
    <>
      {canManage ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            Close for a time
          </Button>
        </div>
      ) : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<FacilityClosure>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty="No closure"
            emptyHint="A closure cancels the bookings it covers and tells their bookers."
            columns={[
              { key: 'when', header: 'When', cell: (c) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(c.startsAt, c.endsAt)}</span> },
              { key: 'reason', header: 'Reason', cell: (c) => humanize(c.reasonCode) },
              {
                key: 'state',
                header: 'State',
                cell: (c) =>
                  c.liftedAt ? (
                    <Badge tone="beige">Lifted · {humanize(c.liftReasonCode)}</Badge>
                  ) : new Date(c.endsAt) <= new Date() ? (
                    <Badge tone="beige">Over</Badge>
                  ) : (
                    <Badge tone="terracotta">In force</Badge>
                  ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (c) =>
                  canManage && !c.liftedAt && new Date(c.endsAt) > new Date() ? (
                    <Button size="sm" onClick={() => setLifting(c)}>
                      Lift
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewClosureDialog facility={facility} onClose={() => setCreating(false)} /> : null}
      <ReasonCodeDialog
        open={lifting !== null}
        onClose={() => setLifting(null)}
        title="Lift the closure?"
        description="Its time is open to bookings again. What it cancelled stays cancelled."
        codes={REASON_CODES.facilityClosureLift}
        confirmLabel="Lift"
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(reasonCode) => lifting && lift.mutate({ id: lifting.id, reasonCode })}
      />
    </>
  );
}
