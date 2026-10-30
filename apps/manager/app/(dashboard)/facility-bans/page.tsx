'use client';

import { fieldError, formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FacilityBan } from '@/lib/queries';

function NewBanDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const accounts = useQuery({ queryKey: [...keys.accounts, 'bookers'], queryFn: () => fetchers.accounts(undefined, 100) });
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities });
  const bookers = (accounts.data?.data ?? []).filter(
    (a) => !a.erased && a.status === 'active' && (a.type === 'resident' || a.type === 'family'),
  );
  const [f, setF] = useState({ accountId: '', facilityId: '', reasonCode: REASON_CODES.facilityBan[0] as string, endsOn: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/facility-bans', {
          body: {
            accountId: f.accountId,
            reasonCode: f.reasonCode,
            ...(f.facilityId ? { facilityId: f.facilityId } : {}),
            ...(f.endsOn ? { endsOn: f.endsOn } : {}),
          },
        }),
      ),
    {
      invalidate: [['facility-bans'], keys.bookingsAll],
      onDone: (b) => {
        toast.show(
          b.cancelledBookingIds.length
            ? `Banned; ${b.cancelledBookingIds.length} booking(s) cancelled and their booker told.`
            : 'Banned; no booking to cancel.',
        );
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Ban from booking"
      description="The account's bookings in that scope that have not started are cancelled, as you would cancel them. Walk-in use and the club are untouched."
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={save.isPending}>
            Ban
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label="Account" error={fieldError(save.error, 'accountId')}>
          {(p) => (
            <Select {...p} value={f.accountId} onChange={set('accountId')}>
              <option value="">Choose…</option>
              {bookers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Facility" error={fieldError(save.error, 'facilityId')}>
          {(p) => (
            <Select {...p} value={f.facilityId} onChange={set('facilityId')}>
              <option value="">Every facility</option>
              {(facilities.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label="Why" error={fieldError(save.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={f.reasonCode} onChange={set('reasonCode')}>
                {REASON_CODES.facilityBan.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Last day" hint="Empty: until lifted." error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Accounts banned from booking (ADR 0067), beside the units' no-show suspensions. */
export default function FacilityBansPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [inForce, setInForce] = useState<'true' | 'false' | ''>('true');
  const [creating, setCreating] = useState(false);
  const [lifting, setLifting] = useState<FacilityBan | null>(null);
  const list = useCursorList(keys.facilityBans({ inForce }), (c) => fetchers.facilityBans({ inForce }, c), {
    enabled: can('bookings.handle'),
  });
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: can('bookings.handle') });
  const nameOf = (id: string | null) =>
    id === null ? 'Every facility' : ((facilities.data?.data ?? []).find((x) => x.id === id)?.nameEn ?? '—');
  const lift = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/facility-bans/{id}/lift', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [['facility-bans']],
      onDone: () => {
        toast.show('Lifted; the account is told.');
        setLifting(null);
      },
    },
  );
  if (ready && !can('bookings.handle'))
    return (
      <>
        <PageHeader title="Facility bans" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Facility bans"
        description="One account kept from booking a facility, or every one, until a day or until lifted."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Ban an account
          </Button>
        }
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select value={inForce} onChange={(e) => setInForce(e.target.value as typeof inForce)}>
          <option value="true">In force</option>
          <option value="false">Over</option>
          <option value="">All</option>
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FacilityBan>
            rows={list.rows}
            rowKey={(b) => b.id}
            empty="No ban"
            columns={[
              { key: 'f', header: 'Facility', cell: (b) => nameOf(b.facilityId) },
              { key: 'r', header: 'Why', cell: (b) => humanize(b.reasonCode) },
              { key: 'c', header: 'Since', cell: (b) => formatDateTime(b.createdAt) },
              { key: 'e', header: 'Until', cell: (b) => (b.endsOn ? formatDate(b.endsOn) : 'Lifted') },
              { key: 's', header: 'State', cell: (b) => humanize(b.state) },
              { key: 'n', header: 'Bookings cancelled', cell: (b) => b.cancelledBookingIds.length },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (b) =>
                  b.state === 'in_force' ? (
                    <Button size="sm" onClick={() => setLifting(b)}>
                      Lift
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewBanDialog onClose={() => setCreating(false)} /> : null}
      <ReasonCodeDialog
        open={lifting !== null}
        onClose={() => setLifting(null)}
        title="Lift the ban"
        codes={REASON_CODES.facilityBanLift}
        confirmLabel="Lift"
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(c) => lifting && lift.mutate({ id: lifting.id, reasonCode: c })}
      />
    </>
  );
}
