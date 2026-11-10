'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { FitOutCards } from '@/components/permits/fit-out';
import { periodText } from '@/components/permits/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffPermit } from '@/lib/queries';
import ar from '@/messages/ar/places-permits';
import en from '@/messages/en/places-permits';

type Worker = NonNullable<StaffPermit['works']>['workers'][number];
type Guest = NonNullable<StaffPermit['event']>['guests'][number];

function Approve({ permit, onClose }: { permit: StaffPermit; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('approved'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('approveTitle', { reference: permit.reference })}
      onSubmit={() => approve.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={approve.isPending}>
            {c('approve')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('approveNote')}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

/** One permit (ADR 0049): what it asks, its people, and the decisions. */
export default function PermitPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(p.status === 'revoked' ? t('revokedToast') : t('rejectedToast'));
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
        toast.show(t('takenOff'));
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
    { invalidate: [keys.permitsAll], onDone: () => toast.show(t('unlocked')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/permits" label={t('title')} />} title={t('permit')} />
        <ForbiddenState />
      </>
    );
  const p = permit.data;
  const lockedWorkers = new Set(p?.lockouts?.workerIds ?? []);
  const erased = <span className="t-secondary">{t('erasedWithAccount')}</span>;
  return (
    <>
      <PageHeader
        back={<Back href="/permits" label={t('title')} />}
        title={p ? t('detailTitle', { reference: p.reference, kind: t(`kind.${p.kind}`) }) : t('permit')}
        description={
          p
            ? p.building
              ? t('detailDescriptionBuilding', { unit: p.unitCode, building: p.building, period: periodText(p, fmt, t) })
              : t('detailDescription', { unit: p.unitCode, period: periodText(p, fmt, t) })
            : undefined
        }
        actions={
          p?.status === 'pending' ? (
            <>
              <Button variant="danger" onClick={() => setRejecting(true)}>
                {c('reject')}
              </Button>
              <Button variant="primary" onClick={() => setApproving(true)}>
                {c('approve')}
              </Button>
            </>
          ) : p?.status === 'approved' ? (
            <Button variant="danger" onClick={() => setRevoking(true)}>
              {t('revoke')}
            </Button>
          ) : null
        }
      />
      <QueryState query={permit}>
        {p ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={p.status} />
                </dd>
                <dt>{t('askedBy')}</dt>
                <dd>
                  {p.requestedBy.fullName ?? '—'} · {fmt.dateTime(p.createdAt)}
                </dd>
                {p.decidedAt ? (
                  <>
                    <dt>{t('decided')}</dt>
                    <dd>
                      {p.decisionSource === 'auto' ? t('decidedAuto') : label(p.rejectReason ?? 'approved')} · {fmt.dateTime(p.decidedAt)}
                      {p.staffNote ? ` · “${p.staffNote}”` : ''}
                    </dd>
                  </>
                ) : null}
                {p.revokedAt ? (
                  <>
                    <dt>{t('revoked')}</dt>
                    <dd>
                      {label(p.revokeReason)} · {fmt.dateTime(p.revokedAt)}
                      {p.revokeNote ? ` · “${p.revokeNote}”` : ''}
                    </dd>
                  </>
                ) : null}
                {p.cancelledAt ? (
                  <>
                    <dt>{t('cancelled')}</dt>
                    <dd>
                      {p.cancelledBy === 'system' ? t('cancelledBy.system') : t('cancelledBy.resident')}
                      {p.cancelReason ? ` · ${label(p.cancelReason)}` : ''} · {fmt.dateTime(p.cancelledAt)}
                    </dd>
                  </>
                ) : null}
                {p.works ? (
                  <>
                    <dt>{t('work')}</dt>
                    <dd>{label(p.works.workType)}</dd>
                    <dt>{t('contractor')}</dt>
                    <dd>{p.works.contractorCompany ?? erased}</dd>
                    <dt>{t('workDescription')}</dt>
                    <dd>{p.works.description ?? erased}</dd>
                  </>
                ) : null}
                {p.move ? (
                  <>
                    <dt>{t('truck')}</dt>
                    <dd className="t-mono">
                      <bdi>{p.move.truckPlate ?? '—'}</bdi>
                    </dd>
                    <dt>{t('items')}</dt>
                    <dd>{p.move.itemsDescription ?? erased}</dd>
                  </>
                ) : null}
                {p.event ? (
                  <>
                    <dt>{t('eventTitle')}</dt>
                    <dd>{p.event.title ?? '—'}</dd>
                    <dt>{t('guests')}</dt>
                    <dd>{t('guestsOf', { count: p.event.guestCount, limit: p.event.guestLimit })}</dd>
                  </>
                ) : null}
                {p.materialExit?.usedAt ? (
                  <>
                    <dt>{t('wentOut')}</dt>
                    <dd>{fmt.dateTime(p.materialExit.usedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </Card>
            {p.works ? (
              <Card flush>
                <CardHeader title={t('workers', { count: p.works.workerCount })} />
                <DataTable<Worker>
                  rows={p.works.workers}
                  rowKey={(w) => w.id}
                  empty={t('noWorker')}
                  columns={[
                    {
                      key: 'f',
                      header: t('col.face'),
                      cell: (w) =>
                        w.photo ? (
                          // A short-lived link to the face, never stored.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={w.photo.url} alt="" width={48} height={48} style={{ borderRadius: 8, objectFit: 'cover' }} />
                        ) : (
                          '—'
                        ),
                    },
                    { key: 'n', header: t('col.name'), cell: (w) => w.fullName ?? <span className="t-secondary">{t('purged')}</span> },
                    { key: 'i', header: t('col.id'), cell: (w) => label(w.idType) },
                    {
                      key: 's',
                      header: t('col.status'),
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
                              {t('unlock')}
                            </Button>
                          ) : null}
                          {!w.removedAt ? (
                            <Button variant="text" onClick={() => setRemoving(w)}>
                              {t('takeOff')}
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
                <CardHeader title={t('lockedGuards')} />
                <p className="t-secondary">{t('lockedHint')}</p>
                <ul className="stack stack--sm">
                  {p.lockouts.guards.map((g) => (
                    <li key={g.id} className="row" style={{ gap: 8 }}>
                      <span>{g.firstName ?? t('aGuard')}</span>
                      <Button variant="text" onClick={() => unlock.mutate({ guard: g.id })}>
                        {t('unlock')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {p.materialExit ? (
              <Card flush>
                <CardHeader title={t('itemsOut')} />
                <DataTable<{ name: string; quantity: number }>
                  rows={p.materialExit.items ?? []}
                  rowKey={(i) => i.name}
                  empty={t('erasedWithAccount')}
                  columns={[
                    { key: 'n', header: t('col.item'), cell: (i) => i.name },
                    { key: 'q', header: t('col.quantity'), cell: (i) => fmt.number(i.quantity) },
                  ]}
                />
                {p.materialExit.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.materialExit.photo.url} alt={t('goodsAlt')} style={{ maxWidth: '100%', borderRadius: 8, margin: 16 }} />
                ) : null}
              </Card>
            ) : null}
            {p.kind === 'works' ? <FitOutCards permitId={p.id} unitId={p.unitId} /> : null}
            {p.event ? (
              <Card flush>
                <CardHeader title={t('guestList')} />
                <DataTable<Guest>
                  rows={p.event.guests}
                  rowKey={(g) => g.id}
                  empty={t('noGuest')}
                  columns={[
                    { key: 'n', header: t('col.name'), cell: (g) => g.fullName ?? <span className="t-secondary">{t('purged')}</span> },
                    { key: 'p', header: t('col.car'), cell: (g) => <span className="t-mono">{g.vehiclePlate ?? '—'}</span> },
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
        title={t('rejectTitle')}
        description={t('rejectDescription')}
        codes={REASON_CODES.unitPermitReject}
        confirmLabel={c('reject')}
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ action: 'reject', reasonCode })}
      />
      <ReasonCodeDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title={t('revokeTitle')}
        description={t('revokeDescription')}
        codes={REASON_CODES.unitPermitRevoke}
        confirmLabel={t('revoke')}
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ action: 'revoke', reasonCode })}
      />
      <ReasonCodeDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing?.fullName ? t('takeOffTitle', { name: removing.fullName }) : t('takeOffTitleAnon')}
        codes={REASON_CODES.permitWorkerRemove}
        confirmLabel={t('takeOff')}
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(reasonCode) => removing && remove.mutate({ workerId: removing.id, reasonCode })}
      />
    </>
  );
}
