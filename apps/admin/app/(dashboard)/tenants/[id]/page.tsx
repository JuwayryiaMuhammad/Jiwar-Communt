'use client';

import { formatDate, formatDateTime, humanize, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, UserPlus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { emptyManager, ManagerFields, managerPayload, type NewManager } from '@/components/manager-fields';
import { api } from '@/lib/api';
import { eventTone } from '@/lib/labels';
import { getTenant, keys, listAudit, listEvents, type Manager, type TenantDetail } from '@/lib/queries';

function AddManagerDialog({ tenant, open, onClose }: { tenant: TenantDetail; open: boolean; onClose: () => void }) {
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
        toast.show(`${m.fullName ?? 'Manager'} added to ${tenant.name}.`);
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
      title="Add a manager"
      description={`A manager account in ${tenant.name}. They sign in with a code sent to this email.`}
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending}>
            Add manager
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

  const t = tenant.data;
  const nextStatus = t?.status === 'active' ? 'suspended' : 'active';

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
        toast.show(res.status === 'suspended' ? `${res.name} is suspended.` : `${res.name} is active again.`);
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
        toast.show(m.status === 'active' ? `${m.fullName} can sign in again.` : `${m.fullName} can no longer sign in.`);
        setManagerChange(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/tenants" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Compounds
          </ButtonLink>
        }
        title={
          t ? (
            <span className="row" style={{ gap: 12 }}>
              {t.name} <StatusBadge status={t.status} />
            </span>
          ) : (
            'Compound'
          )
        }
        description={t ? `Opened ${formatDate(t.createdAt)}` : undefined}
        actions={
          t ? (
            <>
              <Button icon={<UserPlus aria-hidden />} onClick={() => setAdding(true)}>
                Add manager
              </Button>
              <Button
                variant={t.status === 'active' ? 'dark' : 'primary'}
                icon={t.status === 'active' ? <Pause aria-hidden /> : <Play aria-hidden />}
                onClick={() => setConfirmStatus(true)}
              >
                {t.status === 'active' ? 'Suspend' : 'Reactivate'}
              </Button>
            </>
          ) : null
        }
      />

      <QueryState query={tenant}>
        {t ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title="Managers">
                  <span className="t-secondary">Managers run the compound: residents, staff, gates and roles.</span>
                </CardHeader>
                <DataTable<Manager>
                  rows={t.managers}
                  rowKey={(m) => m.id}
                  empty="No managers"
                  columns={[
                    {
                      key: 'name',
                      header: 'Name',
                      cell: (m) =>
                        m.erased ? (
                          <span className="t-secondary">Erased account</span>
                        ) : (
                          <span className="table__primary">{m.fullName}</span>
                        ),
                    },
                    { key: 'email', header: 'Email', cell: (m) => m.email ?? '—' },
                    {
                      key: 'phone',
                      header: 'Phone',
                      cell: (m) => (m.phone ? <span className="t-num">{m.phone}</span> : <span className="t-secondary">—</span>),
                    },
                    { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.erased ? 'erased' : m.status} /> },
                    {
                      key: 'actions',
                      header: <span className="visually-hidden">Actions</span>,
                      className: 'table__actions',
                      cell: (m) =>
                        m.erased || (m.status !== 'active' && m.status !== 'inactive') ? null : (
                          <Button size="sm" onClick={() => setManagerChange(m)}>
                            {m.status === 'active' ? 'Deactivate' : 'Activate'}
                          </Button>
                        ),
                    },
                  ]}
                />
              </Card>

              <Card flush>
                <CardHeader title="Security events in this compound" />
                <QueryState query={events} rows={3}>
                  {events.data?.data.length ? (
                    <ul className="list">
                      {events.data.data.map((e) => (
                        <li key={e.id} className="list__item">
                          <Badge tone={eventTone(e.event)}>{e.event}</Badge>
                          <div className="list__text">
                            <div className="list__meta">{e.ip ?? 'No IP'}</div>
                          </div>
                          <span className="list__meta" title={formatDateTime(e.occurredAt)}>
                            {relativeTime(e.occurredAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title="No events" />
                  )}
                </QueryState>
              </Card>
            </div>

            <div className="stack">
              <Card tone={t.status === 'active' ? 'green' : 'beige'}>
                <div className="stack stack--sm">
                  <span className="t-caption t-secondary">Status</span>
                  <span className="t-title-md">{t.status === 'active' ? 'Open for sign-in' : 'Suspended'}</span>
                  <p className="t-secondary">
                    {t.status === 'active'
                      ? 'Residents, staff and managers can sign in.'
                      : 'Nobody in this compound can sign in or use the API until it is reactivated.'}
                  </p>
                </div>
              </Card>
              <Card>
                <dl className="dl">
                  <dt>Tenant id</dt>
                  <dd className="t-mono">{t.id}</dd>
                  <dt>Opened</dt>
                  <dd>{formatDateTime(t.createdAt)}</dd>
                  <dt>Managers</dt>
                  <dd>{t.managers.filter((m) => m.status === 'active').length} active</dd>
                </dl>
              </Card>
              <Card flush>
                <CardHeader title="History" />
                <QueryState query={audit} rows={3}>
                  {audit.data?.data.length ? (
                    <ul className="list">
                      {audit.data.data.map((a) => (
                        <li key={a.id} className="list__item">
                          <div className="list__text">
                            <div className="list__title">{humanize(a.action)}</div>
                            <div className="list__meta">{formatDateTime(a.occurredAt)}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <CardBody>
                      <span className="t-secondary">No platform actions yet.</span>
                    </CardBody>
                  )}
                </QueryState>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>

      {t ? (
        <>
          <AddManagerDialog tenant={t} open={adding} onClose={() => setAdding(false)} />
          <ConfirmDialog
            open={confirmStatus}
            onClose={() => {
              setConfirmStatus(false);
              setStatus.reset();
            }}
            title={nextStatus === 'suspended' ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`}
            description={
              nextStatus === 'suspended'
                ? 'Everyone in the compound is signed out on their next request and cannot sign in until you reactivate it. No data is deleted.'
                : 'Residents, staff and managers can sign in again.'
            }
            confirmLabel={nextStatus === 'suspended' ? 'Suspend compound' : 'Reactivate'}
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
            title={managerChange?.status === 'active' ? `Deactivate ${managerChange.fullName}?` : `Activate ${managerChange?.fullName}?`}
            description={
              managerChange?.status === 'active'
                ? 'They are signed out and cannot sign in. The compound keeps its other managers.'
                : 'They can sign in again with a code sent to their email.'
            }
            confirmLabel={managerChange?.status === 'active' ? 'Deactivate' : 'Activate'}
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
