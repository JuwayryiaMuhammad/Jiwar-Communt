'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useSlotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { fetchers, keys, type Facility, type FacilityClosure } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { useLocalName } from './bits';
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const slotText = useSlotText();
  const localName = useLocalName();
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
      onDone: (closure) => {
        toast.show(
          closure.cancelledBookings
            ? t('closed', { name: localName(facility), count: closure.cancelledBookings })
            : t('closedNone', { name: localName(facility) }),
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
      title={t('closeTitle', { name: localName(facility) })}
      description={t('closeDescription')}
      onSubmit={() => (ready ? save.mutate() : window && look.mutate())}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          {seen ? (
            <>
              {/* The bookings may have changed meanwhile (FACILITY_CLOSURE_PREVIEW_STALE). */}
              <Button loading={look.isPending} onClick={() => look.mutate()}>
                {t('previewAgain')}
              </Button>
              <Button type="submit" variant="danger" loading={save.isPending} disabled={!ready}>
                {t('closeFacility')}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" loading={look.isPending} disabled={!window}>
              {t('preview')}
            </Button>
          )}
        </>
      }
    >
      <div className="form">
        <Field label={c('from')} error={fieldError(save.error ?? look.error, 'startsAt')}>
          {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => edit(setStartsAt)(e.target.value)} />}
        </Field>
        <Field
          label={t('until')}
          error={fieldError(save.error ?? look.error, 'endsAt') ?? (from && to && to <= from ? t('afterStart') : undefined)}
        >
          {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => edit(setEndsAt)(e.target.value)} />}
        </Field>
        <Field label={c('reason')} error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">{c('select')}</option>
              {REASON_CODES.facilityClosure.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
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
              empty={t('noneAffected')}
              emptyHint={t('noneAffectedHint')}
              columns={[
                { key: 'when', header: t('col.when'), cell: (b) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(b.startsAt, b.endsAt)}</span> },
                { key: 'unit', header: t('col.unit'), cell: (b) => b.unitCode },
                {
                  key: 'fee',
                  header: t('col.fee'),
                  cell: (b) =>
                    b.charge ? (
                      <Badge tone={b.charge.outcome === 'unit_credit' ? 'terracotta' : 'beige'}>
                        {b.charge.outcome === 'unit_credit'
                          ? t('fee.unitCredit', { amount: f.money(b.charge.amount) })
                          : t('fee.invoiceCredited', { amount: f.money(b.charge.amount) })}
                      </Badge>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
            <p className="muted" style={{ padding: '0 1rem 1rem' }}>
              {t('totals', { invoices: f.money(seen.invoicesCredited), credit: f.money(seen.unitCredit) })}
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
  const t = useT(en, ar);
  const label = useLabel();
  const slotText = useSlotText();
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
        toast.show(t('lifted'));
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
            {t('closeForTime')}
          </Button>
        </div>
      ) : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<FacilityClosure>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={t('noClosure')}
            emptyHint={t('noClosureHint')}
            columns={[
              { key: 'when', header: t('col.when'), cell: (c) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(c.startsAt, c.endsAt)}</span> },
              { key: 'reason', header: t('col.reason'), cell: (c) => label(c.reasonCode) },
              {
                key: 'state',
                header: t('col.state'),
                cell: (c) =>
                  c.liftedAt ? (
                    <Badge tone="beige">{t('state.lifted', { reason: label(c.liftReasonCode) })}</Badge>
                  ) : new Date(c.endsAt) <= new Date() ? (
                    <Badge tone="beige">{t('state.over')}</Badge>
                  ) : (
                    <Badge tone="terracotta">{t('state.inForce')}</Badge>
                  ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (c) =>
                  canManage && !c.liftedAt && new Date(c.endsAt) > new Date() ? (
                    <Button size="sm" onClick={() => setLifting(c)}>
                      {t('lift')}
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
        title={t('liftTitle')}
        description={t('liftDescription')}
        codes={REASON_CODES.facilityClosureLift}
        confirmLabel={t('lift')}
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(reasonCode) => lifting && lift.mutate({ id: lifting.id, reasonCode })}
      />
    </>
  );
}
