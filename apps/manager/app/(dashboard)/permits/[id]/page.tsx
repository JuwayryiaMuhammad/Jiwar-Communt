'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { PERMIT_KIND_TEXT, periodText } from '@/components/permits/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffPermit } from '@/lib/queries';

type Worker = NonNullable<StaffPermit['works']>['workers'][number];
type Guest = NonNullable<StaffPermit['event']>['guests'][number];

function Approve({ permit, onClose }: { permit: StaffPermit; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/approve', {
          params: { path: { id: permit.id } },
          body: note.trim() ? { note: note.trim() } : {},
        }),
      ),
    {
      invalidate: [keys.permitsAll],
      onDone: () => {
        toast.show('Approved. The resident was told; the guard sees it at the gate.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Approve ${permit.reference}?`}
      onSubmit={() => approve.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={approve.isPending}>
            Approve
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Note (the management’s own, never shown to the unit)">
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

/** One permit (ADR 0049): what it asks, its people, and the decisions. */
export default function PermitPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const permit = useQuery({ queryKey: keys.permit(id), queryFn: () => fetchers.permit(id), enabled: allowed });
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [removing, setRemoving] = useState<Worker | null>(null);
  const decide = useAction(
    (body: { action: 'reject' | 'revoke'; reasonCode: string }) =>
      unwrap(
        body.action === 'reject'
          ? api.POST('/api/v1/staff/unit-permits/{id}/reject', { params: { path: { id } }, body: { reasonCode: body.reasonCode } })
          : api.POST('/api/v1/staff/unit-permits/{id}/revoke', { params: { path: { id } }, body: { reasonCode: body.reasonCode } }),
      ),
    {
      invalidate: [keys.permitsAll],
      onDone: (p) => {
        toast.show(p.status === 'revoked' ? 'Revoked. The guard refuses it from now on; the resident was told.' : 'Rejected. The resident was told.');
        setRejecting(false);
        setRevoking(false);
      },
    },
  );
  const remove = useAction(
    (body: { workerId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/workers/{workerId}/remove', {
          params: { path: { id, workerId: body.workerId } },
          body: { reasonCode: body.reasonCode },
        }),
      ),
    {
      invalidate: [keys.permitsAll],
      onDone: () => {
        toast.show('Taken off the permit: the guard refuses them from now on.');
        setRemoving(null);
      },
    },
  );
  const unlock = useAction(
    (target: { worker: string } | { guard: string }) =>
      unwrap(
        'worker' in target
          ? api.POST('/api/v1/staff/unit-permits/{id}/workers/{workerId}/unlock', {
              params: { path: { id, workerId: target.worker } },
            })
          : api.POST('/api/v1/staff/unit-permits/{id}/guards/{guardId}/unlock', {
              params: { path: { id, guardId: target.guard } },
            }),
      ),
    { invalidate: [keys.permitsAll], onDone: () => toast.show('Unlocked.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/permits" label="Permits" />} title="Permit" />
        <ForbiddenState />
      </>
    );
  const p = permit.data;
  const lockedWorkers = new Set(p?.lockouts?.workerIds ?? []);
  return (
    <>
      <PageHeader
        back={<Back href="/permits" label="Permits" />}
        title={p ? `${p.reference} · ${PERMIT_KIND_TEXT[p.kind]}` : 'Permit'}
        description={p ? `Unit ${p.unitCode}${p.building ? ` · building ${p.building}` : ''} · ${periodText(p, formatDateTime)}` : undefined}
        actions={
          p?.status === 'pending' ? (
            <>
              <Button variant="danger" onClick={() => setRejecting(true)}>
                Reject
              </Button>
              <Button variant="primary" onClick={() => setApproving(true)}>
                Approve
              </Button>
            </>
          ) : p?.status === 'approved' ? (
            <Button variant="danger" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          ) : null
        }
      />
      <QueryState query={permit}>
        {p ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={p.status} />
                </dd>
                <dt>Asked by</dt>
                <dd>
                  {p.requestedBy.fullName ?? '—'} · {formatDateTime(p.createdAt)}
                </dd>
                {p.decidedAt ? (
                  <>
                    <dt>Decided</dt>
                    <dd>
                      {p.decisionSource === 'auto' ? 'At once (20 guests or fewer)' : humanize(p.rejectReason ?? 'approved')} ·{' '}
                      {formatDateTime(p.decidedAt)}
                      {p.staffNote ? ` · “${p.staffNote}”` : ''}
                    </dd>
                  </>
                ) : null}
                {p.revokedAt ? (
                  <>
                    <dt>Revoked</dt>
                    <dd>
                      {humanize(p.revokeReason ?? '')} · {formatDateTime(p.revokedAt)}
                      {p.revokeNote ? ` · “${p.revokeNote}”` : ''}
                    </dd>
                  </>
                ) : null}
                {p.cancelledAt ? (
                  <>
                    <dt>Cancelled</dt>
                    <dd>
                      {p.cancelledBy === 'system' ? 'By the system' : 'By the resident'}
                      {p.cancelReason ? ` · ${humanize(p.cancelReason)}` : ''} · {formatDateTime(p.cancelledAt)}
                    </dd>
                  </>
                ) : null}
                {p.works ? (
                  <>
                    <dt>Work</dt>
                    <dd>{humanize(p.works.workType)}</dd>
                    <dt>Contractor</dt>
                    <dd>{p.works.contractorCompany ?? <span className="t-secondary">Erased with the resident’s account</span>}</dd>
                    <dt>Description</dt>
                    <dd>{p.works.description ?? <span className="t-secondary">Erased with the resident’s account</span>}</dd>
                  </>
                ) : null}
                {p.move ? (
                  <>
                    <dt>Truck</dt>
                    <dd className="t-mono">{p.move.truckPlate ?? '—'}</dd>
                    <dt>Items</dt>
                    <dd>{p.move.itemsDescription ?? <span className="t-secondary">Erased with the resident’s account</span>}</dd>
                  </>
                ) : null}
                {p.event ? (
                  <>
                    <dt>Title</dt>
                    <dd>{p.event.title ?? '—'}</dd>
                    <dt>Guests</dt>
                    <dd>
                      {p.event.guestCount} of {p.event.guestLimit}
                    </dd>
                  </>
                ) : null}
                {p.materialExit?.usedAt ? (
                  <>
                    <dt>Went out</dt>
                    <dd>{formatDateTime(p.materialExit.usedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </Card>
            {p.works ? (
              <Card flush>
                <CardHeader title={`Contractor workers (${p.works.workerCount})`} />
                <DataTable<Worker>
                  rows={p.works.workers}
                  rowKey={(w) => w.id}
                  empty="No worker yet"
                  columns={[
                    {
                      key: 'f',
                      header: 'Face',
                      cell: (w) =>
                        w.photo ? (
                          // A short-lived link to the face, never stored.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={w.photo.url} alt="" width={48} height={48} style={{ borderRadius: 8, objectFit: 'cover' }} />
                        ) : (
                          '—'
                        ),
                    },
                    { key: 'n', header: 'Name', cell: (w) => w.fullName ?? <span className="t-secondary">Purged</span> },
                    { key: 'i', header: 'ID', cell: (w) => humanize(w.idType) },
                    {
                      key: 's',
                      header: 'Status',
                      cell: (w) =>
                        w.removedAt ? (
                          <StatusBadge status="removed" />
                        ) : lockedWorkers.has(w.id) ? (
                          <StatusBadge status="suspended" />
                        ) : (
                          <StatusBadge status="active" />
                        ),
                    },
                    {
                      key: 'a',
                      header: '',
                      cell: (w) => (
                        <span className="row" style={{ gap: 8 }}>
                          {lockedWorkers.has(w.id) ? (
                            <Button variant="text" onClick={() => unlock.mutate({ worker: w.id })}>
                              Unlock
                            </Button>
                          ) : null}
                          {!w.removedAt ? (
                            <Button variant="text" onClick={() => setRemoving(w)}>
                              Take off
                            </Button>
                          ) : null}
                        </span>
                      ),
                    },
                  ]}
                />
              </Card>
            ) : null}
            {p.lockouts && p.lockouts.guards.length ? (
              <Card>
                <CardHeader title="Guards locked out of the ID check" />
                <p className="t-secondary">Five wrong ID last-fours in 15 minutes lock a guard out, on every permit.</p>
                <ul className="stack stack--sm">
                  {p.lockouts.guards.map((g) => (
                    <li key={g.id} className="row" style={{ gap: 8 }}>
                      <span>{g.firstName ?? 'A guard'}</span>
                      <Button variant="text" onClick={() => unlock.mutate({ guard: g.id })}>
                        Unlock
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {p.materialExit ? (
              <Card flush>
                <CardHeader title="Items going out" />
                <DataTable<{ name: string; quantity: number }>
                  rows={p.materialExit.items ?? []}
                  rowKey={(i) => i.name}
                  empty="Erased with the resident’s account"
                  columns={[
                    { key: 'n', header: 'Item', cell: (i) => i.name },
                    { key: 'q', header: 'Quantity', cell: (i) => i.quantity },
                  ]}
                />
                {p.materialExit.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.materialExit.photo.url} alt="The goods" style={{ maxWidth: '100%', borderRadius: 8, margin: 16 }} />
                ) : null}
              </Card>
            ) : null}
            {p.event ? (
              <Card flush>
                <CardHeader title="Guest list" />
                <DataTable<Guest>
                  rows={p.event.guests}
                  rowKey={(g) => g.id}
                  empty="No guest"
                  columns={[
                    { key: 'n', header: 'Name', cell: (g) => g.fullName ?? <span className="t-secondary">Purged</span> },
                    { key: 'p', header: 'Car', cell: (g) => <span className="t-mono">{g.vehiclePlate ?? '—'}</span> },
                    { key: 's', header: '', cell: (g) => (g.removedAt ? <StatusBadge status="removed" /> : null) },
                  ]}
                />
              </Card>
            ) : null}
            <ErrorAlert error={unlock.error} />
          </div>
        ) : null}
      </QueryState>
      {approving && p ? <Approve permit={p} onClose={() => setApproving(false)} /> : null}
      <ReasonCodeDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this permit?"
        description="The resident is told the reason."
        codes={REASON_CODES.unitPermitReject}
        confirmLabel="Reject"
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ action: 'reject', reasonCode })}
      />
      <ReasonCodeDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title="Revoke this permit?"
        description="The guard refuses it from now on. The resident is told the reason."
        codes={REASON_CODES.unitPermitRevoke}
        confirmLabel="Revoke"
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ action: 'revoke', reasonCode })}
      />
      <ReasonCodeDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Take ${removing?.fullName ?? 'this worker'} off the permit?`}
        codes={REASON_CODES.permitWorkerRemove}
        confirmLabel="Take off"
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(reasonCode) => removing && remove.mutate({ workerId: removing.id, reasonCode })}
      />
    </>
  );
}
