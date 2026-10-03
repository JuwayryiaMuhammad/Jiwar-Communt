'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw } from 'lucide-react';
import { Suspense, useMemo, useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { api } from '@/lib/api';
import { fetchers, keys, type Entry, type Gate } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['entries', 'gates'] as const;
type Tab = (typeof TABS)[number];
type GateKind = Gate['kind'];

/** Entries may be backdated up to 24 h (offline guards); flag a large gap. */
const LATE_MS = 10 * 60 * 1000;

const SUBJECT_TEXT: Record<Entry['subjectType'], string> = {
  visitor_pass: 'Visitor',
  worker_engagement: 'Worker',
  gate_request: 'Approved at gate',
};

const EMPTY = { gateId: '', direction: '', subjectType: '', from: '', to: '' };

function Entries({ gates }: { gates: Gate[] }) {
  const [filters, setFilters] = useState(EMPTY);
  const names = useMemo(() => new Map(gates.map((g) => [g.id, g.name])), [gates]);
  const query = {
    gateId: filters.gateId || undefined,
    direction: (filters.direction || undefined) as Entry['direction'] | undefined,
    subjectType: (filters.subjectType || undefined) as Entry['subjectType'] | undefined,
    from: startOfDay(filters.from),
    to: endOfDay(filters.to),
  };
  const list = useCursorList(keys.entries(query), (c) => fetchers.entries(query, c), { refetchInterval: 30_000 });
  const dirty = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="toolbar">
        <Field label="Gate">
          {(p) => (
            <Select {...p} value={filters.gateId} onChange={(e) => setFilters({ ...filters, gateId: e.target.value })}>
              <option value="">All gates</option>
              {gates.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Direction">
          {(p) => (
            <Select {...p} value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })}>
              <option value="">In and out</option>
              <option value="in">In</option>
              <option value="out">Out</option>
            </Select>
          )}
        </Field>
        <Field label="Who">
          {(p) => (
            <Select {...p} value={filters.subjectType} onChange={(e) => setFilters({ ...filters, subjectType: e.target.value })}>
              <option value="">Everyone</option>
              {Object.entries(SUBJECT_TEXT).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40 }}>
            Reset
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Entry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={dirty ? 'No entry matches these filters' : 'No gate entries yet'}
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (e) => {
                  const late = new Date(e.recordedAt).getTime() - new Date(e.occurredAt).getTime() > LATE_MS;
                  return (
                    <div>
                      <div className="t-num" style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(e.occurredAt)}
                      </div>
                      {late ? (
                        <div className="list__meta" title="Recorded later, e.g. after the guard's device was offline">
                          Recorded {formatDateTime(e.recordedAt)}
                        </div>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'dir',
                header: 'Direction',
                cell: (e) => <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? 'In' : 'Out'}</Badge>,
              },
              { key: 'who', header: 'Who', cell: (e) => SUBJECT_TEXT[e.subjectType] },
              { key: 'unit', header: 'Unit', cell: (e) => <span className="table__primary">{e.unitCode}</span> },
              { key: 'gate', header: 'Gate', cell: (e) => names.get(e.gateId) ?? '—' },
              {
                key: 'method',
                header: 'How',
                cell: (e) => (
                  <span className="row">
                    {humanize(e.method)}
                    {e.unconfirmed ? <Badge tone="terracotta">Unconfirmed</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'guard',
                header: 'Guard',
                cell: (e) => (e.guard ? (e.guard.erased ? 'Erased account' : e.guard.fullName) : <span className="t-secondary">System</span>),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}

function GateDialog({ gate, open, onClose }: { gate: Gate | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(gate?.name ?? '');
  const [kind, setKind] = useState<GateKind>(gate?.kind ?? 'mixed');
  const save = useAction(
    () =>
      gate
        ? unwrap(api.PATCH('/api/v1/gates/{id}', { params: { path: { id: gate.id } }, body: { name: name.trim(), kind } }))
        : unwrap(api.POST('/api/v1/gates', { body: { name: name.trim(), kind } })),
    {
      invalidate: [keys.gates],
      onDone: (g) => {
        toast.show(gate ? `${g.name} saved.` : `${g.name} added.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={gate ? `Edit ${gate.name}` : 'New gate'}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
            {gate ? 'Save' : 'Add gate'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name" hint="As guards know it, e.g. Main gate." error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as GateKind)}>
              <option value="mixed">Pedestrians and vehicles</option>
              <option value="pedestrian">Pedestrians</option>
              <option value="vehicle">Vehicles</option>
            </Select>
          )}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Gates({ query }: { query: { data?: { data: Gate[] }; isPending: boolean; error: unknown } }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Gate | 'new' | null>(null);
  const toggle = useAction(
    (g: Gate) =>
      unwrap(
        api.PATCH('/api/v1/gates/{id}', {
          params: { path: { id: g.id } },
          body: { status: g.status === 'active' ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.gates],
      onDone: (g) => toast.show(g.status === 'active' ? `${g.name} is open for shifts.` : `${g.name} is closed; no new shifts.`),
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          Guards start their shift at an active gate.
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          New gate
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={query}>
          <DataTable<Gate>
            rows={query.data?.data}
            rowKey={(g) => g.id}
            empty="No gates yet"
            columns={[
              { key: 'name', header: 'Gate', cell: (g) => <span className="table__primary">{g.name}</span> },
              { key: 'kind', header: 'Kind', cell: (g) => humanize(g.kind) },
              { key: 'status', header: 'Status', cell: (g) => <StatusBadge status={g.status} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (g) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(g)}>
                      Edit
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === g.id} onClick={() => toggle.mutate(g)}>
                      {g.status === 'active' ? 'Deactivate' : 'Activate'}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? (
        <GateDialog gate={editing === 'new' ? null : editing} open onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function GateView() {
  const [tab, setTab] = useTab(TABS, 'entries');
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates });
  return (
    <>
      <PageHeader
        title="Gate"
        description="Every entry and exit, append-only, and the gates guards work at."
        actions={
          <Segmented<Tab>
            label="Gate"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'entries', label: 'Entries' },
              { value: 'gates', label: 'Gates' },
            ]}
          />
        }
      />
      {tab === 'entries' ? <Entries gates={gates.data?.data ?? []} /> : <Gates query={gates} />}
    </>
  );
}

export default function GatePage() {
  return (
    <Suspense>
      <GateView />
    </Suspense>
  );
}
