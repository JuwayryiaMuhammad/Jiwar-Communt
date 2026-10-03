'use client';

import { formatDate, humanize, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
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
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { emptyOccupancy, OccupancyRow } from '@/components/occupancy-row';
import { api } from '@/lib/api';
import { fetchers, keys, type ResidentDetail } from '@/lib/queries';

type Occupancy = Schema<'OccupancyResponse'>;
type OccupancyInput = Schema<'OccupancyInputDto'>;

function ContactDialog({ resident, open, onClose }: { resident: ResidentDetail; open: boolean; onClose: () => void }) {
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
        toast.show('Contact updated. Pending sign-in codes were cancelled.');
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
      title="Update contact"
      description="Sign-in codes go to the email."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={unchanged}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Email" error={fieldError(save.error, 'email')}>
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Phone" error={fieldError(save.error, 'phone')}>
          {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function AddUnitDialog({ residentId, open, onClose }: { residentId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<OccupancyInput>(emptyOccupancy);
  const add = useAction(
    () =>
      unwrap(api.POST('/api/v1/residents/{id}/occupancies', { params: { path: { id: residentId } }, body: value })),
    {
      invalidate: [keys.resident(residentId), keys.residents, keys.units],
      onDone: (o) => {
        toast.show(`Added to unit ${o.unitCode}.`);
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
      title="Add a unit"
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!value.unitId}>
            Add
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
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusChange, setStatusChange] = useState(false);
  const resident = useQuery({ queryKey: keys.resident(id), queryFn: () => fetchers.resident(id) });
  const r = resident.data;
  const active = r?.status === 'active';

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
        toast.show(a.status === 'active' ? 'Account activated.' : 'Account deactivated.');
        setStatusChange(false);
      },
    },
  );

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/residents" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Residents
          </ButtonLink>
        }
        title={
          r ? (
            <span className="row" style={{ gap: 12 }}>
              {r.erased ? 'Erased account' : r.fullName} <StatusBadge status={r.erased ? 'erased' : r.status} />
            </span>
          ) : (
            'Resident'
          )
        }
        actions={
          r && !r.erased ? (
            <>
              <Button icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
                Contact
              </Button>
              <Button icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
                Add unit
              </Button>
              {r.status === 'active' || r.status === 'inactive' ? (
                <Button variant={active ? 'dark' : 'primary'} onClick={() => setStatusChange(true)}>
                  {active ? 'Deactivate' : 'Activate'}
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
              <CardHeader title="Units" />
              <DataTable<Occupancy>
                rows={r.occupancies}
                rowKey={(o) => o.id}
                empty="No occupancy"
                columns={[
                  {
                    key: 'unit',
                    header: 'Unit',
                    cell: (o) => (
                      <Link className="table__link" href={`/units/${o.unitId}`}>
                        {o.unitCode}
                      </Link>
                    ),
                  },
                  {
                    key: 'type',
                    header: 'As',
                    cell: (o) => (
                      <span className="row">
                        {humanize(o.occupancyType)}
                        {o.isPrimary ? <Badge tone="green">Primary</Badge> : null}
                      </span>
                    ),
                  },
                  { key: 'resides', header: 'Lives there', cell: (o) => (o.resides ? 'Yes' : 'No') },
                  { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
                  {
                    key: 'dates',
                    header: 'Period',
                    cell: (o) => (
                      <span className="t-num">
                        {formatDate(o.startedAt)} – {o.endedAt ? formatDate(o.endedAt) : 'now'}
                        {o.endReason ? <span className="list__meta"> · {humanize(o.endReason)}</span> : null}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
            <Card>
              {r.erased ? (
                <p className="t-secondary">This account was erased. Only its id remains.</p>
              ) : (
                <dl className="dl">
                  <dt>Email</dt>
                  <dd>{r.email}</dd>
                  <dt>Phone</dt>
                  <dd className="t-num">{r.phone ?? 'Released (frozen account)'}</dd>
                  <dt>Document</dt>
                  <dd>
                    {humanize(r.idDocumentType)} <span className="t-mono">{r.idDocumentNumberMasked}</span>
                  </dd>
                  <dt>Nationality</dt>
                  <dd>{r.nationality ?? '—'}</dd>
                  <dt>Birth date</dt>
                  <dd>{formatDate(r.birthDate)}</dd>
                  <dt>Language</dt>
                  <dd>{r.preferredLocale === 'en' ? 'English' : 'Arabic'}</dd>
                </dl>
              )}
            </Card>
          </div>
        ) : null}
      </QueryState>
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
            title={active ? `Deactivate ${r.fullName}?` : `Activate ${r.fullName}?`}
            description={
              active ? 'They are signed out and cannot sign in. Their units and household stay as they are.' : 'They can sign in again.'
            }
            confirmLabel={active ? 'Deactivate' : 'Activate'}
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
