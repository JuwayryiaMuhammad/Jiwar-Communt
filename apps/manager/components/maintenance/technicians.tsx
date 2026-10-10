'use client';

import { formatDateTime, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, ReasonCodeDialog, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Specialty, type Technician } from '@/lib/queries';

function SpecialtiesDialog({
  technician,
  specialties,
  onClose,
}: {
  technician: Technician;
  specialties: Specialty[];
  onClose: () => void;
}) {
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
        toast.show(`${technician.fullName ?? 'Technician'}'s specialties are saved.`);
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
      title={`Specialties of ${technician.fullName ?? 'this technician'}`}
      description="Auto-dispatch offers a ticket only to technicians with a specialty its category needs. None ticked clears them all."
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
        {shown.length === 0 ? <p className="t-secondary">The compound has no specialties yet.</p> : null}
        {shown.map((s) => (
          <Checkbox
            key={s.id}
            label={s.active ? s.nameEn : `${s.nameEn} (no longer in use)`}
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
  const toast = useToast();
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, refetchInterval: 60_000 });
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties });
  const [editing, setEditing] = useState<Technician | null>(null);
  const [switching, setSwitching] = useState<Technician | null>(null);
  const names = new Map((specialties.data?.data ?? []).map((s) => [s.id, s.nameEn]));

  const setAvailability = useAction(
    (v: { t: Technician; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/technicians/{id}/availability', {
          params: { path: { id: v.t.id } },
          body: { state: v.t.availability.state === 'available' ? 'unavailable' : 'available', reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [keys.technicians, keys.ticketsAll],
      onDone: (state, v) => {
        toast.show(`${v.t.fullName ?? 'Technician'} is now ${state.state}.`);
        setSwitching(null);
      },
    },
  );
  const goingOff = switching?.availability.state === 'available';

  return (
    <>
      <Card flush>
        <QueryState query={technicians}>
          <DataTable<Technician>
            rows={technicians.data?.data}
            rowKey={(t) => t.id}
            empty="No technician yet"
            emptyHint="Add a staff account with the technician role on the Staff page."
            columns={[
              { key: 'name', header: 'Technician', cell: (t) => <span className="table__primary">{t.fullName ?? '—'}</span> },
              {
                key: 'availability',
                header: 'Availability',
                cell: (t) => (
                  <span className="row" title={t.availability.since ? `Since ${formatDateTime(t.availability.since)}` : undefined}>
                    <StatusBadge status={t.availability.state} />
                    {t.availability.since ? <span className="t-secondary">{relativeTime(t.availability.since)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'specialties',
                header: 'Specialties',
                cell: (t) =>
                  t.specialties.length ? (
                    <span className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {t.specialties.map((s) => (
                        <Badge key={s.id} plain>
                          {names.get(s.id) ?? s.key}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="t-secondary">None</span>
                  ),
              },
              {
                key: 'open',
                header: 'Open tickets',
                cell: (t) =>
                  t.openTickets ? (
                    <Link className="table__link t-num" href={`/maintenance?technicianId=${t.id}`}>
                      {t.openTickets}
                    </Link>
                  ) : (
                    <span className="t-num">0</span>
                  ),
              },
              {
                key: 'workload',
                header: <span title="Open tickets weighted by status and priority: what auto-dispatch balances.">Workload</span>,
                cell: (t) => <span className="t-num">{t.workload}</span>,
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (t) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(t)}>
                      Specialties
                    </Button>
                    <Button size="sm" onClick={() => setSwitching(t)}>
                      {t.availability.state === 'available' ? 'Set unavailable' : 'Set available'}
                    </Button>
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
        title={goingOff ? `Set ${switching?.fullName ?? 'this technician'} unavailable?` : `Set ${switching?.fullName ?? 'this technician'} available?`}
        description={
          goingOff
            ? 'Auto-dispatch stops offering them tickets. The tickets they already have stay with them until you reassign them.'
            : 'Auto-dispatch may offer them tickets again, starting with those waiting in the queue.'
        }
        codes={REASON_CODES.availabilityChange}
        confirmLabel={goingOff ? 'Set unavailable' : 'Set available'}
        pending={setAvailability.isPending}
        error={<ErrorAlert error={setAvailability.error} />}
        onConfirm={(reasonCode) => switching && setAvailability.mutate({ t: switching, reasonCode })}
      />
    </>
  );
}
