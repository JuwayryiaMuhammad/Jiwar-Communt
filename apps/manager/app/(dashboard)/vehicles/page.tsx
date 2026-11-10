'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
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
import ar from '@/messages/ar/safety-vehicles';
import en from '@/messages/en/safety-vehicles';

const today = () => new Date().toLocaleDateString('en-CA');
const VIEWS = ['pending', 'active', 'expires_soon', 'expired', 'rejected', 'removed', 'all'] as const;
type View = (typeof VIEWS)[number];

function Approve({ vehicle, onClose }: { vehicle: StaffVehicleDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('approved'));
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
      title={t('approveTitle', { plate: vehicle.plate, unit: vehicle.unitCode })}
      description={t('approveDescription')}
      onSubmit={() => ready && approve.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={approve.isPending} disabled={!ready}>
            {t('approve')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field
          label={t('stickerNumber')}
          hint={t('stickerHint')}
          error={fieldError(approve.error, 'stickerNumber') ?? (sticker && !validSticker(sticker) ? t('stickerInvalid') : undefined)}
        >
          {(p) => <Input {...p} maxLength={20} value={sticker} onChange={(e) => setSticker(e.target.value)} />}
        </Field>
        <Field label={t('validThrough')} error={fieldError(approve.error, 'permitValidUntil') ?? (dateProblem ? t(`date.${dateProblem}`) : undefined)}>
          {(p) => <Input {...p} type="date" min={addDays(today(), 1)} max={addDays(today(), 731)} value={until} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

function Renew({ vehicle, onClose }: { vehicle: StaffVehicleDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const current = vehicle.permitValidUntil ?? today();
  const [until, setUntil] = useState(addDays(current > today() ? current : today(), 365));
  const renew = useAction(
    () => unwrap(api.POST('/api/v1/staff/vehicles/{id}/renew', { params: { path: { id: vehicle.id } }, body: { permitValidUntil: until } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show(t('renewed'));
        onClose();
      },
    },
  );
  const problem = permitDateProblem(until, today(), vehicle.permitValidUntil ?? undefined);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('renewTitle', { plate: vehicle.plate })}
      description={t('renewDescription', { day: fmt.day(current) })}
      onSubmit={() => !problem && renew.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={renew.isPending} disabled={!!problem}>
            {t('renew')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('newLastDay')} error={fieldError(renew.error, 'permitValidUntil') ?? (problem ? t(`date.${problem}`) : undefined)}>
          {(p) => <Input {...p} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        <ErrorAlert error={renew.error} />
      </div>
    </Dialog>
  );
}

function VehicleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const vehicle = useQuery({ queryKey: keys.vehicle(id), queryFn: () => fetchers.vehicle(id) });
  const [step, setStep] = useState<'approve' | 'reject' | 'renew' | 'remove' | null>(null);
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/vehicles/{id}/reject', { params: { path: { id } }, body: { version: vehicle.data!.version, reasonCode } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show(t('rejectedToast'));
        setStep(null);
      },
    },
  );
  const remove = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/vehicles/{id}/remove', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.vehiclesAll],
      onDone: () => {
        toast.show(t('removedToast'));
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
        title={v ? t('detailTitle', { plate: v.plate, unit: v.unitCode }) : t('vehicle')}
        description={
          v
            ? t('detailDescription', { reference: v.reference, model: v.makeAndModel, color: v.color, type: label(v.type).toLocaleLowerCase() })
            : undefined
        }
        footer={
          <>
            {v?.status === 'pending' ? (
              <>
                <Button onClick={() => setStep('reject')}>{t('reject')}</Button>
                <Button variant="primary" onClick={() => setStep('approve')}>
                  {t('approve')}
                </Button>
              </>
            ) : null}
            {v?.status === 'active' ? <Button onClick={() => setStep('renew')}>{t('renew')}</Button> : null}
            {v && v.status !== 'removed' ? (
              <Button variant="danger" onClick={() => setStep('remove')}>
                {t('remove')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={vehicle} rows={4}>
          {v ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('permit')}</dt>
                <dd>
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={v.permitStatus} />
                    {v.permitValidUntil ? <span className="t-secondary">{t('through', { day: fmt.day(v.permitValidUntil) })}</span> : null}
                    {v.stickerNumber ? <Badge plain>{t('sticker', { number: v.stickerNumber })}</Badge> : null}
                  </span>
                </dd>
                <dt>{t('registeredBy')}</dt>
                <dd>{v.registeredBy.erased ? t('erased') : v.registeredBy.fullName}</dd>
                <dt>{t('registered')}</dt>
                <dd>{fmt.dateTime(v.createdAt)}</dd>
                {v.decidedAt ? (
                  <>
                    <dt>{t('decided')}</dt>
                    <dd>
                      {fmt.dateTime(v.decidedAt)}
                      {v.decidedBy ? ` · ${v.decidedBy.erased ? c('erasedAccount') : v.decidedBy.fullName}` : ''}
                      {v.rejectionReason ? ` · ${label(v.rejectionReason)}` : ''}
                    </dd>
                  </>
                ) : null}
                {v.removedAt ? (
                  <>
                    <dt>{t('removed')}</dt>
                    <dd>
                      {fmt.dateTime(v.removedAt)}
                      {v.removalSide ? ` · ${t(`removedBy.${v.removalSide}`)}` : ''}
                      {v.removalReason ? ` · ${label(v.removalReason)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
              {v.licencePhotoUrl ? (
                <a className="btn btn--secondary btn--sm" href={v.licencePhotoUrl} target="_blank" rel="noreferrer">
                  {t('openLicence')}
                </a>
              ) : (
                <span className="t-secondary">{t('noLicence')}</span>
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
        title={t('rejectTitle', { plate: v?.plate ?? '' })}
        description={t('rejectDescription')}
        codes={REASON_CODES.vehicleReject}
        confirmLabel={t('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
      <ReasonCodeDialog
        open={step === 'remove'}
        onClose={() => setStep(null)}
        title={t('removeTitle', { plate: v?.plate ?? '' })}
        description={t('removeDescription')}
        codes={REASON_CODES.vehicleStaffRemove}
        confirmLabel={t('remove')}
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
  const t = useT(en, ar);
  const fmt = useFormat();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={t('plate')}>
          {(p) => <Input {...p} placeholder={t('platePlaceholder')} value={plate} onChange={(e) => setPlate(e.target.value)} />}
        </Field>
        <Field label={t('unitCode')}>
          {(p) => <Input {...p} placeholder={t('unitCodePlaceholder')} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffVehicle>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty={view === 'pending' ? t('emptyPending') : t('emptyMatch')}
            columns={[
              {
                key: 'plate',
                header: t('col.plate'),
                cell: (v) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(v.id)}>
                    {v.plate}
                  </Button>
                ),
              },
              { key: 'unit', header: t('col.unit'), cell: (v) => <span className="t-mono">{v.unitCode}</span> },
              { key: 'car', header: t('col.vehicle'), cell: (v) => t('car', { model: v.makeAndModel, color: v.color }) },
              { key: 'permit', header: t('col.permit'), cell: (v) => <StatusBadge status={v.permitStatus} /> },
              {
                key: 'until',
                header: t('col.through'),
                cell: (v) => (v.permitValidUntil ? fmt.day(v.permitValidUntil) : <span className="t-secondary">—</span>),
              },
              { key: 'sticker', header: t('col.sticker'), cell: (v) => <span className="t-mono">{v.stickerNumber ?? '—'}</span> },
              {
                key: 'registered',
                header: t('col.registered'),
                cell: (v) => <span title={fmt.dateTime(v.createdAt)}>{fmt.relative(v.createdAt)}</span>,
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
