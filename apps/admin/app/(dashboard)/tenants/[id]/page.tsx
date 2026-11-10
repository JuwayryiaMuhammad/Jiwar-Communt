'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EventBadge } from '@/components/event-badge';
import { emptyManager, ManagerFields, managerPayload, type NewManager } from '@/components/manager-fields';
import { PaymentGatewayCard } from '@/components/payment-gateway-card';
import { api } from '@/lib/api';
import { useCodeLabel } from '@/lib/labels';
import { getTenant, keys, listAudit, listEvents, type Manager, type TenantDetail } from '@/lib/queries';
import ar from '@/messages/ar/tenants';
import en from '@/messages/en/tenants';

function AddManagerDialog({ tenant, open, onClose }: { tenant: TenantDetail; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [manager, setManager] = useState<NewManager>(emptyManager);
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/platform/tenants/{id}/managers', {
          params: { path: { id: tenant.id } },
          body: managerPayload(manager),
        }),
      ),
    {
      invalidate: [keys.tenant(tenant.id)],
      onDone: (m) => {
        toast.show(
          m.fullName
            ? t('add.done', { name: m.fullName, compound: tenant.name })
            : t('add.doneUnnamed', { compound: tenant.name }),
        );
        close();
      },
    },
  );
  function close() {
    setManager(emptyManager);
    add.reset();
    onClose();
  }
  return (
    <Dialog
      wide
      open={open}
      onClose={close}
      title={t('add.title')}
      description={t('add.description', { name: tenant.name })}
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending}>
            {t('add.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ManagerFields value={manager} onChange={setManager} error={add.error} />
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

export default function TenantPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useCodeLabel();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [managerChange, setManagerChange] = useState<Manager | null>(null);

  const tenant = useQuery({ queryKey: keys.tenant(id), queryFn: () => getTenant(id) });
  const audit = useQuery({
    queryKey: keys.audit({ targetTenantId: id }),
    queryFn: () => listAudit({ targetTenantId: id }, undefined, 8),
  });
  const events = useQuery({
    queryKey: keys.events({ tenantId: id }),
    queryFn: () => listEvents({ tenantId: id }, undefined, 8),
  });

  const compound = tenant.data;
  const nextStatus = compound?.status === 'active' ? 'suspended' : 'active';

  const setStatus = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/platform/tenants/{id}/status', {
          params: { path: { id } },
          body: { status: nextStatus },
        }),
      ),
    {
      invalidate: [keys.tenants, keys.audit({ targetTenantId: id })],
      onDone: (res) => {
        toast.show(res.status === 'suspended' ? t('detail.suspended', { name: res.name }) : t('detail.reactivated', { name: res.name }));
        setConfirmStatus(false);
      },
    },
  );

  const setManagerStatus = useAction(
    (m: Manager) =>
      unwrap(
        api.PATCH('/api/v1/platform/tenants/{id}/managers/{accountId}/status', {
          params: { path: { id, accountId: m.id } },
          body: { status: m.status === 'active' ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.tenant(id)],
      onDone: (m) => {
        toast.show(
          m.status === 'active' ? t('managers.activated', { name: m.fullName }) : t('managers.deactivated', { name: m.fullName }),
        );
        setManagerChange(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/tenants" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('title')}
          </ButtonLink>
        }
        title={
          compound ? (
            <span className="row" style={{ gap: 12 }}>
              {compound.name} <StatusBadge status={compound.status} />
            </span>
          ) : (
            t('detail.fallbackTitle')
          )
        }
        description={compound ? t('detail.opened', { date: fmt.date(compound.createdAt) }) : undefined}
        actions={
          compound ? (
            <>
              <Button icon={<UserPlus aria-hidden />} onClick={() => setAdding(true)}>
                {t('detail.addManager')}
              </Button>
              <Button
                variant={compound.status === 'active' ? 'dark' : 'primary'}
                icon={compound.status === 'active' ? <Pause aria-hidden /> : <Play aria-hidden />}
                onClick={() => setConfirmStatus(true)}
              >
                {compound.status === 'active' ? t('detail.suspend') : t('detail.reactivate')}
              </Button>
            </>
          ) : null
        }
      />

      <QueryState query={tenant}>
        {compound ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title={t('managers.title')}>
                  <span className="t-secondary">{t('managers.body')}</span>
                </CardHeader>
                <DataTable<Manager>
                  rows={compound.managers}
                  rowKey={(m) => m.id}
                  empty={t('managers.empty')}
                  columns={[
                    {
                      key: 'name',
                      header: c('name'),
                      cell: (m) =>
                        m.erased ? (
                          <span className="t-secondary">{t('managers.erased')}</span>
                        ) : (
                          <span className="table__primary">{m.fullName}</span>
                        ),
                    },
                    { key: 'email', header: c('email'), cell: (m) => m.email ?? '—' },
                    {
                      key: 'phone',
                      header: c('phone'),
                      cell: (m) => (m.phone ? <span className="t-num">{m.phone}</span> : <span className="t-secondary">—</span>),
                    },
                    { key: 'status', header: c('status'), cell: (m) => <StatusBadge status={m.erased ? 'erased' : m.status} /> },
                    {
                      key: 'actions',
                      header: <span className="visually-hidden">{c('actions')}</span>,
                      className: 'table__actions',
                      cell: (m) =>
                        m.erased || (m.status !== 'active' && m.status !== 'inactive') ? null : (
                          <Button size="sm" onClick={() => setManagerChange(m)}>
                            {m.status === 'active' ? t('managers.deactivate') : t('managers.activate')}
                          </Button>
                        ),
                    },
                  ]}
                />
              </Card>

              <PaymentGatewayCard tenantId={compound.id} />

              <Card flush>
                <CardHeader title={t('events.title')} />
                <QueryState query={events} rows={3}>
                  {events.data?.data.length ? (
                    <ul className="list">
                      {events.data.data.map((e) => (
                        <li key={e.id} className="list__item">
                          <EventBadge event={e.event} />
                          <div className="list__text">
                            <div className="list__meta">{e.ip ? <bdi>{e.ip}</bdi> : t('events.noIp')}</div>
                          </div>
                          <span className="list__meta" title={fmt.dateTime(e.occurredAt)}>
                            {fmt.relative(e.occurredAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('events.empty')} />
                  )}
                </QueryState>
              </Card>
            </div>

            <div className="stack">
              <Card tone={compound.status === 'active' ? 'green' : 'beige'}>
                <div className="stack stack--sm">
                  <span className="t-caption t-secondary">{c('status')}</span>
                  <span className="t-title-md">{compound.status === 'active' ? t('state.open') : t('state.suspended')}</span>
                  <p className="t-secondary">
                    {compound.status === 'active' ? t('state.openBody') : t('state.suspendedBody')}
                  </p>
                </div>
              </Card>
              <Card>
                <dl className="dl">
                  <dt>{t('col.id')}</dt>
                  <dd className="t-mono">{compound.id}</dd>
                  <dt>{t('col.opened')}</dt>
                  <dd>{fmt.dateTime(compound.createdAt)}</dd>
                  <dt>{t('facts.managers')}</dt>
                  <dd>{t('facts.activeManagers', { n: compound.managers.filter((m) => m.status === 'active').length })}</dd>
                </dl>
              </Card>
              <Card flush>
                <CardHeader title={t('history.title')} />
                <QueryState query={audit} rows={3}>
                  {audit.data?.data.length ? (
                    <ul className="list">
                      {audit.data.data.map((a) => (
                        <li key={a.id} className="list__item">
                          <div className="list__text">
                            <div className="list__title">{label(a.action)}</div>
                            <div className="list__meta">{fmt.dateTime(a.occurredAt)}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <CardBody>
                      <span className="t-secondary">{t('history.empty')}</span>
                    </CardBody>
                  )}
                </QueryState>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>

      {compound ? (
        <>
          <AddManagerDialog tenant={compound} open={adding} onClose={() => setAdding(false)} />
          <ConfirmDialog
            open={confirmStatus}
            onClose={() => {
              setConfirmStatus(false);
              setStatus.reset();
            }}
            title={
              nextStatus === 'suspended'
                ? t('confirm.suspendTitle', { name: compound.name })
                : t('confirm.reactivateTitle', { name: compound.name })
            }
            description={nextStatus === 'suspended' ? t('confirm.suspendBody') : t('confirm.reactivateBody')}
            confirmLabel={nextStatus === 'suspended' ? t('confirm.suspendLabel') : t('detail.reactivate')}
            danger={nextStatus === 'suspended'}
            pending={setStatus.isPending}
            error={<ErrorAlert error={setStatus.error} />}
            onConfirm={() => setStatus.mutate(undefined)}
          />
          <ConfirmDialog
            open={managerChange !== null}
            onClose={() => {
              setManagerChange(null);
              setManagerStatus.reset();
            }}
            title={
              managerChange?.status === 'active'
                ? t('confirm.deactivateTitle', { name: managerChange.fullName })
                : t('confirm.activateTitle', { name: managerChange?.fullName })
            }
            description={managerChange?.status === 'active' ? t('confirm.deactivateBody') : t('confirm.activateBody')}
            confirmLabel={managerChange?.status === 'active' ? t('managers.deactivate') : t('managers.activate')}
            danger={managerChange?.status === 'active'}
            pending={setManagerStatus.isPending}
            error={<ErrorAlert error={setManagerStatus.error} />}
            onConfirm={() => managerChange && setManagerStatus.mutate(managerChange)}
          />
        </>
      ) : null}
    </>
  );
}
