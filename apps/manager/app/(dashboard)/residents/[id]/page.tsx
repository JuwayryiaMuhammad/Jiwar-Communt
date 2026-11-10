'use client';

import { ApiError, ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  ReasonCodeDialog,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { emptyOccupancy, OccupancyRow } from '@/components/occupancy-row';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ResidentDetail } from '@/lib/queries';
import ar from '@/messages/ar/res-residents';
import en from '@/messages/en/res-residents';

type Occupancy = Schema<'OccupancyResponse'>;
type OccupancyInput = Schema<'OccupancyInputDto'>;

function ContactDialog({ resident, open, onClose }: { resident: ResidentDetail; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [email, setEmail] = useState(resident.email ?? '');
  const [phone, setPhone] = useState(resident.phone ?? '');
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/residents/{id}/contact', {
          params: { path: { id: resident.id } },
          body: {
            ...(email.trim() !== (resident.email ?? '') ? { email: email.trim() } : {}),
            ...(phone.trim() !== (resident.phone ?? '') ? { phone: phone.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.resident(resident.id), keys.residents],
      onDone: () => {
        toast.show(t('contactUpdated'));
        onClose();
      },
    },
  );
  const unchanged = email.trim() === (resident.email ?? '') && phone.trim() === (resident.phone ?? '');
  return (
    <Dialog
      open={open}
      onClose={() => {
        save.reset();
        onClose();
      }}
      title={t('updateContact')}
      description={t('codesGoToEmail')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={unchanged}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('email')} error={fieldError(save.error, 'email')}>
          {(p) => <Input {...p} className="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label={c('phone')} error={fieldError(save.error, 'phone')}>
          {(p) => <Input {...p} className="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function AddUnitDialog({ residentId, open, onClose }: { residentId: string; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [value, setValue] = useState<OccupancyInput>(emptyOccupancy);
  const add = useAction(
    () =>
      unwrap(api.POST('/api/v1/residents/{id}/occupancies', { params: { path: { id: residentId } }, body: value })),
    {
      invalidate: [keys.resident(residentId), keys.residents, keys.units],
      onDone: (o) => {
        toast.show(t('addedToUnit', { unit: o.unitCode }));
        close();
      },
    },
  );
  function close() {
    setValue(emptyOccupancy);
    add.reset();
    onClose();
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('addUnitTitle')}
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!value.unitId}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <OccupancyRow value={value} onChange={setValue} error={fieldError(add.error, 'unitId')} />
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

export default function ResidentPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { can } = usePermissions();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusChange, setStatusChange] = useState(false);
  const resident = useQuery({ queryKey: keys.resident(id), queryFn: () => fetchers.resident(id) });
  const r = resident.data;
  const active = r?.status === 'active';
  const [handingOver, setHandingOver] = useState<Occupancy | null>(null);
  const handover = useAction(
    (v: { o: Occupancy; reasonCode?: string }) =>
      unwrap(
        api.POST('/api/v1/occupancies/{id}/handover', {
          params: { path: { id: v.o.id } },
          body: v.reasonCode ? { reasonCode: v.reasonCode } : {},
        }),
      ),
    {
      invalidate: [keys.resident(id)],
      onDone: (o) => {
        toast.show(t('handoverRecorded', { unit: o.unitCode }));
        setHandingOver(null);
      },
    },
  );
  // With no clearance on its planned move-out, the handover takes a code (ADR 0063).
  const needsReason =
    handover.error instanceof ApiError && handover.error.code === 'MOVE_HANDOVER_REASON_REQUIRED'
      ? (handover.variables?.o ?? null)
      : null;

  const setStatus = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/accounts/{id}/status', {
          params: { path: { id } },
          body: { status: active ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.resident(id), keys.residents],
      onDone: (a) => {
        toast.show(a.status === 'active' ? t('activated') : t('deactivated'));
        setStatusChange(false);
      },
    },
  );

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/residents" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('title')}
          </ButtonLink>
        }
        title={
          r ? (
            <span className="row" style={{ gap: 12 }}>
              {r.erased ? t('erasedAccount') : r.fullName} <StatusBadge status={r.erased ? 'erased' : r.status} />
            </span>
          ) : (
            t('residentTitle')
          )
        }
        actions={
          r && !r.erased ? (
            <>
              {can('accounts.read') ? <ButtonLink href={`/accounts/${r.id}`}>{t('account')}</ButtonLink> : null}
              <Button icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
                {t('contact')}
              </Button>
              <Button icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
                {t('addUnit')}
              </Button>
              {r.status === 'active' || r.status === 'inactive' ? (
                <Button variant={active ? 'dark' : 'primary'} onClick={() => setStatusChange(true)}>
                  {active ? t('deactivate') : t('activate')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={resident}>
        {r ? (
          <div className="grid grid--main-aside">
            <Card flush>
              <CardHeader title={t('occupancies')} />
              <DataTable<Occupancy>
                rows={r.occupancies}
                rowKey={(o) => o.id}
                empty={t('noOccupancy')}
                columns={[
                  {
                    key: 'unit',
                    header: t('col.unit'),
                    cell: (o) => (
                      <Link className="table__link" href={`/units/${o.unitId}`}>
                        <span className="ltr">{o.unitCode}</span>
                      </Link>
                    ),
                  },
                  {
                    key: 'type',
                    header: t('col.as'),
                    cell: (o) => (
                      <span className="row">
                        {label(o.occupancyType)}
                        {o.isPrimary ? <Badge tone="green">{t('primary')}</Badge> : null}
                      </span>
                    ),
                  },
                  { key: 'resides', header: t('col.lives'), cell: (o) => (o.resides ? c('yes') : c('no')) },
                  { key: 'status', header: c('status'), cell: (o) => <StatusBadge status={o.status} /> },
                  {
                    key: 'dates',
                    header: t('col.period'),
                    cell: (o) => (
                      <span className="t-num">
                        {f.date(o.startedAt)} – {o.endedAt ? f.date(o.endedAt) : t('now')}
                        {o.endReason ? <span className="list__meta"> · {label(o.endReason)}</span> : null}
                      </span>
                    ),
                  },
                  {
                    key: 'handover',
                    header: t('col.handover'),
                    cell: (o) =>
                      o.status !== 'ended' ? (
                        <span className="t-secondary">—</span>
                      ) : o.handedOverAt ? (
                        <span title={t('handedBack')}>{f.date(o.handedOverAt)}</span>
                      ) : can('residents.manage') ? (
                        <Button size="sm" loading={handover.isPending && handover.variables?.o.id === o.id} onClick={() => setHandingOver(o)}>
                          {t('recordHandover')}
                        </Button>
                      ) : (
                        <span className="t-secondary">{t('notYet')}</span>
                      ),
                  },
                ]}
              />
            </Card>
            <Card>
              {r.erased ? (
                <p className="t-secondary">{t('erasedNote')}</p>
              ) : (
                <dl className="dl">
                  <dt>{c('email')}</dt>
                  <dd className="ltr">{r.email}</dd>
                  <dt>{c('phone')}</dt>
                  <dd className="t-num ltr">{r.phone ?? t('phoneFrozen')}</dd>
                  <dt>{t('document')}</dt>
                  <dd>
                    {label(r.idDocumentType)} <span className="t-mono ltr">{r.idDocumentNumberMasked}</span>
                  </dd>
                  <dt>{t('nationality')}</dt>
                  <dd>{r.nationality ?? '—'}</dd>
                  <dt>{t('birthDate')}</dt>
                  <dd>{f.day(r.birthDate)}</dd>
                  <dt>{t('language')}</dt>
                  <dd>{r.preferredLocale === 'en' ? t('locale.en') : t('locale.ar')}</dd>
                </dl>
              )}
            </Card>
          </div>
        ) : null}
      </QueryState>
      <ConfirmDialog
        open={handingOver !== null && needsReason === null}
        onClose={() => {
          setHandingOver(null);
          handover.reset();
        }}
        title={t('handoverTitle', { unit: handingOver?.unitCode ?? '' })}
        description={t('handoverDescription')}
        confirmLabel={t('recordHandover')}
        pending={handover.isPending}
        error={<ErrorAlert error={handover.error} />}
        onConfirm={() => handingOver && handover.mutate({ o: handingOver })}
      />
      <ReasonCodeDialog
        open={needsReason !== null}
        onClose={() => {
          setHandingOver(null);
          handover.reset();
        }}
        title={t('noClearanceTitle')}
        description={t('noClearanceDescription')}
        codes={REASON_CODES.handoverWithoutClearance}
        confirmLabel={t('recordHandover')}
        pending={handover.isPending}
        error={handover.variables?.reasonCode && handover.error ? <ErrorText error={handover.error} /> : undefined}
        onConfirm={(reasonCode) => needsReason && handover.mutate({ o: needsReason, reasonCode })}
      />
      {r && !r.erased ? (
        <>
          {editing ? <ContactDialog resident={r} open onClose={() => setEditing(false)} /> : null}
          <AddUnitDialog residentId={r.id} open={adding} onClose={() => setAdding(false)} />
          <ConfirmDialog
            open={statusChange}
            onClose={() => {
              setStatusChange(false);
              setStatus.reset();
            }}
            title={active ? t('deactivateTitle', { name: r.fullName ?? '' }) : t('activateTitle', { name: r.fullName ?? '' })}
            description={active ? t('deactivateDescription') : t('activateDescription')}
            confirmLabel={active ? t('deactivate') : t('activate')}
            danger={active}
            pending={setStatus.isPending}
            error={<ErrorAlert error={setStatus.error} />}
            onConfirm={() => setStatus.mutate(undefined)}
          />
        </>
      ) : null}
    </>
  );
}
