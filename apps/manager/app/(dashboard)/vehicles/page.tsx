'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { addDays, permitDateProblem, validSticker } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type StaffVehicle,
  type StaffVehicleDetail,
  type VehicleFilters,
  type VehiclePermitStatus,
} from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');
const VIEWS = ['pending', 'active', 'expires_soon', 'expired', 'rejected', 'removed', 'all'] as const;
type View = (typeof VIEWS)[number];

function Approve({ vehicle, onClose }: { vehicle: StaffVehicleDetail; onClose: () => void }) {
  const toast = useToast();
  const [sticker, setSticker] = useState('');
  const [until, setUntil] = useState(addDays(today(), 365));
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/vehicles/{id}/approve', {
          params: { path: { id: vehicle.id } },
          body: { version: vehicle.version, stickerNumber: sticker.trim(), permitValidUntil: until },
        }),
      ),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show('Approved. The registrant is told.');
        onClose();
      },
    },
  );
  const dateProblem = permitDateProblem(until, today());
  const ready = validSticker(sticker) && !dateProblem;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Approve ${vehicle.plate} · unit ${vehicle.unitCode}`}
      description="A sticker number is issued once in the compound, ever. The permit is valid through its last day."
      onSubmit={() => ready && approve.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={approve.isPending} disabled={!ready}>
            Approve
          </Button>
        </>
      }
    >
      <div className="form">
        <Field
          label="Sticker number"
          hint="Letters, digits and dashes."
          error={fieldError(approve.error, 'stickerNumber') ?? (sticker && !validSticker(sticker) ? 'Letters, digits and dashes, up to 20.' : undefined)}
        >
          {(p) => <Input {...p} maxLength={20} value={sticker} onChange={(e) => setSticker(e.target.value)} />}
        </Field>
        <Field label="Permit valid through" error={fieldError(approve.error, 'permitValidUntil') ?? dateProblem}>
          {(p) => <Input {...p} type="date" min={addDays(today(), 1)} max={addDays(today(), 731)} value={until} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

function Renew({ vehicle, onClose }: { vehicle: StaffVehicleDetail; onClose: () => void }) {
  const toast = useToast();
  const current = vehicle.permitValidUntil ?? today();
  const [until, setUntil] = useState(addDays(current > today() ? current : today(), 365));
  const renew = useAction(
    () => unwrap(api.POST('/api/v1/staff/vehicles/{id}/renew', { params: { path: { id: vehicle.id } }, body: { permitValidUntil: until } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show('Renewed.');
        onClose();
      },
    },
  );
  const problem = permitDateProblem(until, today(), vehicle.permitValidUntil ?? undefined);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Renew the permit of ${vehicle.plate}`}
      description={`Valid through ${current} today. The sticker stays.`}
      onSubmit={() => !problem && renew.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={renew.isPending} disabled={!!problem}>
            Renew
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="New last day" error={fieldError(renew.error, 'permitValidUntil') ?? problem}>
          {(p) => <Input {...p} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        <ErrorAlert error={renew.error} />
      </div>
    </Dialog>
  );
}

function VehicleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const vehicle = useQuery({ queryKey: keys.vehicle(id), queryFn: () => fetchers.vehicle(id) });
  const [step, setStep] = useState<'approve' | 'reject' | 'renew' | 'remove' | null>(null);
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/vehicles/{id}/reject', { params: { path: { id } }, body: { version: vehicle.data!.version, reasonCode } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show('Rejected. The registrant is told the reason.');
        setStep(null);
      },
    },
  );
  const remove = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/vehicles/{id}/remove', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show('Removed. Its sticker and permit are void.');
        setStep(null);
      },
    },
  );
  const v = vehicle.data;
  return (
    <>
      <Dialog
        open={step === null || step === 'reject' || step === 'remove'}
        wide
        onClose={onClose}
        title={v ? `${v.plate} · unit ${v.unitCode}` : 'Vehicle'}
        description={v ? `${v.reference} · ${v.makeAndModel}, ${v.color}, ${humanize(v.type).toLowerCase()}` : undefined}
        footer={
          <>
            {v?.status === 'pending' ? (
              <>
                <Button onClick={() => setStep('reject')}>Reject</Button>
                <Button variant="primary" onClick={() => setStep('approve')}>
                  Approve
                </Button>
              </>
            ) : null}
            {v?.status === 'active' ? <Button onClick={() => setStep('renew')}>Renew</Button> : null}
            {v && v.status !== 'removed' ? (
              <Button variant="danger" onClick={() => setStep('remove')}>
                Remove
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={vehicle} rows={4}>
          {v ? (
            <div className="stack">
              <dl className="dl">
                <dt>Permit</dt>
                <dd>
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={v.permitStatus} />
                    {v.permitValidUntil ? <span className="t-secondary">through {v.permitValidUntil}</span> : null}
                    {v.stickerNumber ? <Badge plain>Sticker {v.stickerNumber}</Badge> : null}
                  </span>
                </dd>
                <dt>Registered by</dt>
                <dd>{v.registeredBy.erased ? 'An erased account' : v.registeredBy.fullName}</dd>
                <dt>Registered</dt>
                <dd>{formatDateTime(v.createdAt)}</dd>
                {v.decidedAt ? (
                  <>
                    <dt>Decided</dt>
                    <dd>
                      {formatDateTime(v.decidedAt)}
                      {v.decidedBy ? ` · ${v.decidedBy.erased ? 'an erased account' : v.decidedBy.fullName}` : ''}
                      {v.rejectionReason ? ` · ${humanize(v.rejectionReason)}` : ''}
                    </dd>
                  </>
                ) : null}
                {v.removedAt ? (
                  <>
                    <dt>Removed</dt>
                    <dd>
                      {formatDateTime(v.removedAt)} · {v.removalSide === 'system' ? 'by the system' : `by the ${v.removalSide}`}
                      {v.removalReason ? ` · ${humanize(v.removalReason)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
              {v.licencePhotoUrl ? (
                <a className="btn btn--secondary btn--sm" href={v.licencePhotoUrl} target="_blank" rel="noreferrer">
                  Open the licence
                </a>
              ) : (
                <span className="t-secondary">No licence photo</span>
              )}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {v && step === 'approve' ? <Approve vehicle={v} onClose={() => setStep(null)} /> : null}
      {v && step === 'renew' ? <Renew vehicle={v} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'reject'}
        onClose={() => setStep(null)}
        title={`Reject ${v?.plate ?? ''}?`}
        description="The registrant is told the reason. A new plate sends it back to you."
        codes={REASON_CODES.vehicleReject}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
      <ReasonCodeDialog
        open={step === 'remove'}
        onClose={() => setStep(null)}
        title={`Remove ${v?.plate ?? ''}?`}
        description="Final: its sticker and permit are void, and the unit no longer sees it."
        codes={REASON_CODES.vehicleStaffRemove}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(code) => remove.mutate(code)}
      />
    </>
  );
}

/**
 * The compound's vehicles (ADR 0045): the approvals queue, oldest first,
 * and every permit by its state. A plate is searched by its key: spaces and
 * Arabic or Western digits do not matter.
 */
export default function VehiclesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('vehicles.manage');
  const [view, setView] = useState<View>('pending');
  const [plate, setPlate] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('vehicle');
    if (linked) setOpen(linked);
  }, []);
  const filters: VehicleFilters = {
    status: view === 'all' ? '' : (view as VehiclePermitStatus),
    plate: plate.trim(),
    unitCode: unitCode.trim(),
  };
  const list = useCursorList(keys.vehicles(filters), (c) => fetchers.vehicles(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Vehicles" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Vehicles" description="The units’ vehicles and their permits. Approve with a sticker and a last day; a new plate comes back here." />
      <div className="toolbar">
        <Segmented<View>
          label="Vehicles shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'pending', label: 'To approve' },
            { value: 'active', label: 'Active' },
            { value: 'expires_soon', label: 'Expiring' },
            { value: 'expired', label: 'Expired' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'removed', label: 'Removed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Plate">
          {(p) => <Input {...p} placeholder="e.g. ق ب ط 1234" value={plate} onChange={(e) => setPlate(e.target.value)} />}
        </Field>
        <Field label="Unit code">
          {(p) => <Input {...p} placeholder="e.g. A-101" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffVehicle>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty={view === 'pending' ? 'No vehicle waits for approval' : 'No vehicle matches'}
            columns={[
              {
                key: 'plate',
                header: 'Plate',
                cell: (v) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(v.id)}>
                    {v.plate}
                  </Button>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (v) => <span className="t-mono">{v.unitCode}</span> },
              { key: 'car', header: 'Vehicle', cell: (v) => `${v.makeAndModel}, ${v.color}` },
              { key: 'permit', header: 'Permit', cell: (v) => <StatusBadge status={v.permitStatus} /> },
              { key: 'until', header: 'Through', cell: (v) => v.permitValidUntil ?? <span className="t-secondary">—</span> },
              { key: 'sticker', header: 'Sticker', cell: (v) => <span className="t-mono">{v.stickerNumber ?? '—'}</span> },
              {
                key: 'registered',
                header: 'Registered',
                cell: (v) => <span title={formatDateTime(v.createdAt)}>{relativeTime(v.createdAt)}</span>,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <VehicleDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
