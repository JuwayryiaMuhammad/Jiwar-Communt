'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocalName } from '@/components/facilities/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FacilityBan } from '@/lib/queries';
import ar from '@/messages/ar/fac-bans';
import en from '@/messages/en/fac-bans';

function NewBanDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const localName = useLocalName();
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
          b.cancelledBookingIds.length ? t('banned', { count: b.cancelledBookingIds.length }) : t('bannedNone'),
        );
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="danger" loading={save.isPending}>
            {t('ban')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label={t('account')} error={fieldError(save.error, 'accountId')}>
          {(p) => (
            <Select {...p} value={f.accountId} onChange={set('accountId')}>
              <option value="">{t('choose')}</option>
              {bookers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('col.facility')} error={fieldError(save.error, 'facilityId')}>
          {(p) => (
            <Select {...p} value={f.facilityId} onChange={set('facilityId')}>
              <option value="">{t('everyFacility')}</option>
              {(facilities.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {localName(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label={t('col.why')} error={fieldError(save.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={f.reasonCode} onChange={set('reasonCode')}>
                {REASON_CODES.facilityBan.map((code) => (
                  <option key={code} value={code}>
                    {label(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('lastDay')} hint={t('lastDayHint')} error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Accounts banned from booking (ADR 0067), beside the units' no-show suspensions. */
export default function FacilityBansPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const localName = useLocalName();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [inForce, setInForce] = useState<'true' | 'false' | ''>('true');
  const [creating, setCreating] = useState(false);
  const [lifting, setLifting] = useState<FacilityBan | null>(null);
  const list = useCursorList(keys.facilityBans({ inForce }), (x) => fetchers.facilityBans({ inForce }, x), {
    enabled: can('bookings.handle'),
  });
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: can('bookings.handle') });
  const nameOf = (id: string | null) => {
    if (id === null) return t('everyFacility');
    const found = (facilities.data?.data ?? []).find((x) => x.id === id);
    return found ? localName(found) : '—';
  };
  const lift = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/facility-bans/{id}/lift', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [['facility-bans']],
      onDone: () => {
        toast.show(t('liftedToast'));
        setLifting(null);
      },
    },
  );
  if (ready && !can('bookings.handle'))
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
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('banAccount')}
          </Button>
        }
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select value={inForce} onChange={(e) => setInForce(e.target.value as typeof inForce)} aria-label={c('status')}>
          <option value="true">{t('view.true')}</option>
          <option value="false">{t('view.false')}</option>
          <option value="">{t('view.all')}</option>
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FacilityBan>
            rows={list.rows}
            rowKey={(b) => b.id}
            empty={t('empty')}
            columns={[
              { key: 'f', header: t('col.facility'), cell: (b) => nameOf(b.facilityId) },
              { key: 'r', header: t('col.why'), cell: (b) => label(b.reasonCode) },
              { key: 'c', header: t('col.since'), cell: (b) => fmt.dateTime(b.createdAt) },
              { key: 'e', header: t('col.until'), cell: (b) => (b.endsOn ? fmt.day(b.endsOn) : t('lifted')) },
              { key: 's', header: c('status'), cell: (b) => label(b.state) },
              { key: 'n', header: t('col.cancelled'), cell: (b) => fmt.number(b.cancelledBookingIds.length) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (b) =>
                  b.state === 'in_force' ? (
                    <Button size="sm" onClick={() => setLifting(b)}>
                      {t('lift')}
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
        title={t('liftTitle')}
        codes={REASON_CODES.facilityBanLift}
        confirmLabel={t('lift')}
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(code) => lifting && lift.mutate({ id: lifting.id, reasonCode: code })}
      />
    </>
  );
}
