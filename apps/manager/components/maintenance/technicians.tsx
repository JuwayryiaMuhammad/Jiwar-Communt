'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, ReasonCodeDialog, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Specialty, type Technician } from '@/lib/queries';
import ar from '@/messages/ar/maint-technicians';
import en from '@/messages/en/maint-technicians';

function SpecialtiesDialog({
  technician,
  specialties,
  onClose,
}: {
  technician: Technician;
  specialties: Specialty[];
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [picked, setPicked] = useState(() => new Set(technician.specialties.map((s) => s.id)));
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/maintenance/technicians/{id}/specialties', {
          params: { path: { id: technician.id } },
          body: { specialtyIds: [...picked] },
        }),
      ),
    {
      invalidate: [keys.technicians],
      onDone: () => {
        toast.show(t('specialtiesSaved', { name: technician.fullName ?? t('technician') }));
        onClose();
      },
    },
  );
  // A specialty no longer in use stays listed while the technician has it,
  // so saving does not drop it silently.
  const shown = specialties.filter((s) => s.active || picked.has(s.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('specialtiesTitle', { name: technician.fullName ?? t('thisTechnician') })}
      description={t('specialtiesDescription')}
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
        {shown.length === 0 ? <p className="t-secondary">{t('noSpecialties')}</p> : null}
        {shown.map((s) => (
          <Checkbox
            key={s.id}
            label={s.active ? s.nameEn : t('retired', { name: s.nameEn })}
            checked={picked.has(s.id)}
            onChange={(e) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(s.id);
                else next.delete(s.id);
                return next;
              })
            }
          />
        ))}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** Who can take a ticket now: availability, specialties and workload (ADR 0033). */
export function Technicians() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, refetchInterval: 60_000 });
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties });
  const [editing, setEditing] = useState<Technician | null>(null);
  const [switching, setSwitching] = useState<Technician | null>(null);
  const names = new Map((specialties.data?.data ?? []).map((s) => [s.id, s.nameEn]));

  const setAvailability = useAction(
    // Taking a technician off needs a reason; putting them back takes none.
    (v: { t: Technician; reasonCode?: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/technicians/{id}/availability', {
          params: { path: { id: v.t.id } },
          body: v.reasonCode ? { state: 'unavailable', reasonCode: v.reasonCode } : { state: 'available' },
        }),
      ),
    {
      invalidate: [keys.technicians, keys.ticketsAll],
      onDone: (state, v) => {
        toast.show(t('availabilitySaved', { name: v.t.fullName ?? t('technician'), state: state.state }));
        setSwitching(null);
      },
    },
  );

  return (
    <>
      {/* Setting someone available has no dialog: its refusal shows here. */}
      {switching === null ? <ErrorAlert error={setAvailability.error} /> : null}
      <Card flush>
        <QueryState query={technicians}>
          <DataTable<Technician>
            rows={technicians.data?.data}
            rowKey={(x) => x.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              { key: 'name', header: t('col.technician'), cell: (x) => <span className="table__primary">{x.fullName ?? '—'}</span> },
              {
                key: 'availability',
                header: t('col.availability'),
                cell: (x) => (
                  <span className="row" title={x.availability.since ? t('since', { when: fmt.dateTime(x.availability.since) }) : undefined}>
                    <StatusBadge status={x.availability.state} />
                    {x.availability.since ? <span className="t-secondary">{fmt.relative(x.availability.since)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'specialties',
                header: t('col.specialties'),
                cell: (x) =>
                  x.specialties.length ? (
                    <span className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {x.specialties.map((s) => (
                        <Badge key={s.id} plain>
                          {names.get(s.id) ?? s.key}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="t-secondary">{c('none')}</span>
                  ),
              },
              {
                key: 'open',
                header: t('col.open'),
                cell: (x) =>
                  x.openTickets ? (
                    <Link className="table__link t-num" href={`/maintenance?technicianId=${x.id}`}>
                      {fmt.number(x.openTickets)}
                    </Link>
                  ) : (
                    <span className="t-num">{fmt.number(0)}</span>
                  ),
              },
              {
                key: 'workload',
                header: <span title={t('workloadHint')}>{t('col.workload')}</span>,
                cell: (x) => <span className="t-num">{fmt.number(x.workload)}</span>,
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (x) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(x)}>
                      {t('specialties')}
                    </Button>
                    {x.availability.state === 'available' ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          setAvailability.reset();
                          setSwitching(x);
                        }}
                      >
                        {t('setUnavailable')}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={setAvailability.isPending} onClick={() => setAvailability.mutate({ t: x })}>
                        {t('setAvailable')}
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? (
        <SpecialtiesDialog technician={editing} specialties={specialties.data?.data ?? []} onClose={() => setEditing(null)} />
      ) : null}
      <ReasonCodeDialog
        open={switching !== null}
        onClose={() => {
          setSwitching(null);
          setAvailability.reset();
        }}
        title={t('unavailableTitle', { name: switching?.fullName ?? t('thisTechnician') })}
        description={t('unavailableDescription')}
        codes={REASON_CODES.availabilityChange}
        confirmLabel={t('setUnavailable')}
        pending={setAvailability.isPending}
        error={<ErrorAlert error={setAvailability.error} />}
        onConfirm={(reasonCode) => switching && setAvailability.mutate({ t: switching, reasonCode })}
      />
    </>
  );
}
