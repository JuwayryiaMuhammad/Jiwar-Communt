'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { DateRange } from '@/components/date-range';
import { addDays, personName, postName, today } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type HandoverItem, type StaffHandover } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['handovers', 'checklist'] as const;
type Tab = (typeof TABS)[number];

function ItemDialog({ item, onClose }: { item: HandoverItem | null; onClose: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState(item?.label ?? '');
  const [position, setPosition] = useState(String(item?.position ?? 0));
  const body = { label: label.trim(), position: Number(position) };
  const save = useAction(
    () =>
      item
        ? unwrap(api.PATCH('/api/v1/staff/security/handover-items/{id}', { params: { path: { id: item.id } }, body }))
        : unwrap(api.POST('/api/v1/staff/security/handover-items', { body })),
    {
      invalidate: [keys.handoverItems],
      onDone: () => {
        toast.show(item ? 'Item saved.' : 'Item added: guards tick it from their next end.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? 'Edit item' : 'New checklist item'}
      description="Every active item is ticked when a guard ends a shift. A handover keeps the words it was ticked under."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!label.trim()}>
            {item ? 'Save' : 'Add item'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Item" error={fieldError(save.error, 'label')}>
          {(p) => <Input {...p} autoFocus maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <Field label="Order" hint="Lower first (0–1000)." error={fieldError(save.error, 'position')}>
          {(p) => <Input {...p} type="number" min={0} max={1000} value={position} onChange={(e) => setPosition(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Checklist() {
  const toast = useToast();
  const items = useQuery({ queryKey: keys.handoverItems, queryFn: fetchers.handoverItems });
  const [editing, setEditing] = useState<HandoverItem | 'new' | null>(null);
  const toggle = useAction(
    (i: HandoverItem) =>
      unwrap(api.PATCH('/api/v1/staff/security/handover-items/{id}', { params: { path: { id: i.id } }, body: { active: !i.active } })),
    { invalidate: [keys.handoverItems], onDone: (i) => toast.show(i.active ? 'Asked again.' : 'Retired.') },
  );
  return (
    <div className="stack">
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          At most 30 active items. Retired ones are asked no more; an item is never deleted.
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          New item
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={items}>
          <DataTable<HandoverItem>
            rows={items.data?.data}
            rowKey={(i) => i.id}
            empty="No checklist: guards end their shifts with notes alone"
            columns={[
              { key: 'label', header: 'Item', cell: (i) => <span className="table__primary">{i.label}</span> },
              { key: 'order', header: 'Order', cell: (i) => <span className="t-num">{i.position}</span> },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.active ? 'active' : 'inactive'} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (i) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(i)}>
                      Edit
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === i.id} onClick={() => toggle.mutate(i)}>
                      {i.active ? 'Retire' : 'Restore'}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? <ItemDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function HandoverDetail({ h, onClose }: { h: StaffHandover; onClose: () => void }) {
  return (
    <Dialog open wide onClose={onClose} title={`Handover · ${postName(h.post)}`} description={formatDateTime(h.createdAt)} footer={<Button onClick={onClose}>Done</Button>}>
      <dl className="dl">
        <dt>By</dt>
        <dd>{personName(h.guard)}</dd>
        <dt>Kind</dt>
        <dd>{h.kind === 'system' ? 'Ended by the system (post out of service, or the guard left)' : 'Handed over by the guard'}</dd>
        <dt>Checklist</dt>
        <dd>{h.checklist.length ? h.checklist.map((c) => c.label).join(' · ') : '—'}</dd>
        <dt>Notes</dt>
        <dd>{h.notes ?? '—'}</dd>
        <dt>Tasks carried</dt>
        <dd>{h.carriedTaskIds.length}</dd>
        <dt>Acknowledged</dt>
        <dd>{h.acknowledgedAt ? `${personName(h.acknowledgedBy)} · ${formatDateTime(h.acknowledgedAt)}` : 'Not yet'}</dd>
      </dl>
    </Dialog>
  );
}

function Handovers() {
  const [range, setRange] = useState({ from: addDays(today(), -6), to: today() });
  const [state, setState] = useState<'pending' | 'acknowledged' | ''>('');
  const [open, setOpen] = useState<StaffHandover | null>(null);
  const f = { ...range, state };
  const list = useQuery({ queryKey: keys.handovers(f), queryFn: () => fetchers.handovers(f) });
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
        <Segmented<'pending' | 'acknowledged' | ''>
          label="Handovers shown"
          value={state}
          onChange={setState}
          options={[
            { value: '', label: 'All' },
            { value: 'pending', label: 'Waiting' },
            { value: 'acknowledged', label: 'Acknowledged' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffHandover>
            rows={list.data?.data}
            rowKey={(h) => h.id}
            empty="No handover in this period"
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (h) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(h)}>
                    {formatDateTime(h.createdAt)}
                  </Button>
                ),
              },
              { key: 'post', header: 'Post', cell: (h) => postName(h.post) },
              { key: 'guard', header: 'By', cell: (h) => personName(h.guard) },
              { key: 'kind', header: 'Kind', cell: (h) => <StatusBadge status={h.kind === 'system' ? 'closed' : 'done'} /> },
              { key: 'ack', header: 'Acknowledged', cell: (h) => (h.acknowledgedAt ? personName(h.acknowledgedBy) : 'Waiting') },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <HandoverDetail h={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function HandoversView() {
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'handovers');
  if (ready && !can('guard_roster.manage'))
    return (
      <>
        <PageHeader title="Handovers" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Handovers" description="What each guard handed over at the end of a shift, and the checklist they tick." />
      <div className="toolbar">
        <Segmented<Tab>
          label="Handovers"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'handovers', label: 'Handovers' },
            { value: 'checklist', label: 'Checklist' },
          ]}
        />
      </div>
      {tab === 'handovers' ? <Handovers /> : <Checklist />}
    </>
  );
}

export default function HandoversPage() {
  return (
    <Suspense>
      <HandoversView />
    </Suspense>
  );
}
