'use client';

import { formatDateTime, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, Textarea, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { personName, postName } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FoundItem, type FoundItemStatus } from '@/lib/queries';

const VIEWS = ['at_gate', 'with_management', 'claimed', 'all'] as const;
type View = (typeof VIEWS)[number];

function RegisterDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/found-items', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { description: description.trim(), ...(location.trim() ? { location: location.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.foundItemsAll],
      onDone: () => {
        toast.show('Registered at the office.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Register a found item"
      description="At the office. Guards register what they find at the gate from the app."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!description.trim()}>
            Register
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="What" error={fieldError(save.error, 'description')}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Where it was found" error={fieldError(save.error, 'location')}>
          {(p) => <Input {...p} maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ClaimDialog({ item, onClose }: { item: FoundItem; onClose: () => void }) {
  const toast = useToast();
  const [unitCode, setUnitCode] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const claim = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/found-items/{id}/claim', {
          params: { path: { id: item.id } },
          body: {
            ...(unitCode.trim() ? { unitCode: unitCode.trim() } : {}),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.foundItemsAll],
      onDone: () => {
        toast.show('Claimed.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record the owner’s claim"
      description="A unit and/or a name as told. The name is kept 30 days, as a visitor’s."
      onSubmit={() => claim.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={claim.isPending} disabled={!unitCode.trim() && !name.trim()}>
            Record claim
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Unit code" error={fieldError(claim.error, 'unitCode')}>
          {(p) => <Input {...p} maxLength={40} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
        <Field label="Name" error={fieldError(claim.error, 'name')}>
          {(p) => <Input {...p} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Note" error={fieldError(claim.error, 'note')}>
          {(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={claim.error} />
      </div>
    </Dialog>
  );
}

/**
 * The gate's lost-and-found register (ADR 0050): what security found or
 * was handed. The residents' board is the neighbours' lost and found.
 */
export default function FoundItemsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('found_items.manage');
  const [view, setView] = useState<View>('at_gate');
  const [registering, setRegistering] = useState(false);
  const [claiming, setClaiming] = useState<FoundItem | null>(null);
  const status: FoundItemStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.foundItems(status), (c) => fetchers.foundItems(status, c), { enabled: allowed });
  const receive = useAction(
    (i: FoundItem) => unwrap(api.POST('/api/v1/staff/security/found-items/{id}/receive', { params: { path: { id: i.id } } })),
    { invalidate: [keys.foundItemsAll], onDone: () => toast.show('Received from the gate.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Found at the gate" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Found at the gate"
        description={
          <>
            What security registered. To show residents an item, post it on the{' '}
            {can('neighbours.handle') ? <Link href="/lost-found">lost and found board</Link> : 'lost and found board'}.
          </>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Items shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'at_gate', label: 'At the gate' },
            { value: 'with_management', label: 'At the office' },
            { value: 'claimed', label: 'Claimed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setRegistering(true)}>
          Register
        </Button>
      </div>
      <ErrorAlert error={receive.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<FoundItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="Nothing here"
            columns={[
              { key: 'what', header: 'What', cell: (i) => <span className="table__primary">{i.description}</span> },
              { key: 'where', header: 'Where', cell: (i) => [i.place?.nameEn, i.location].filter(Boolean).join(' · ') || '—' },
              { key: 'found', header: 'Found', cell: (i) => <span title={formatDateTime(i.foundAt)}>{relativeTime(i.foundAt)}</span> },
              { key: 'by', header: 'Registered by', cell: (i) => `${personName(i.registeredBy)}${i.registeredAt ? ` · ${postName(i.registeredAt)}` : ''}` },
              {
                key: 'status',
                header: 'Status',
                cell: (i) => (
                  <span className="row">
                    <StatusBadge status={i.status} />
                    {i.claim ? <span className="t-secondary">{[i.claim.unitCode, i.claim.name].filter(Boolean).join(' · ')}</span> : null}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (i) =>
                  i.status === 'claimed' ? null : (
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      {i.status === 'at_gate' ? (
                        <Button size="sm" loading={receive.isPending && receive.variables?.id === i.id} onClick={() => receive.mutate(i)}>
                          Received
                        </Button>
                      ) : null}
                      <Button size="sm" onClick={() => setClaiming(i)}>
                        Claimed
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {registering ? <RegisterDialog onClose={() => setRegistering(false)} /> : null}
      {claiming ? <ClaimDialog item={claiming} onClose={() => setClaiming(null)} /> : null}
    </>
  );
}
