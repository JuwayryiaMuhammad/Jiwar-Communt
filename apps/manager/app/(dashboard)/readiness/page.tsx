'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReadinessProgram } from '@/lib/queries';

const KINDS = ['season', 'event', 'emergency'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewProgramDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const start = new Date(Date.now() + 30 * 24 * 3_600_000);
  const [f, setF] = useState({
    kind: 'season' as (typeof KINDS)[number],
    title: '',
    startsOn: iso(start),
    endsOn: iso(new Date(start.getTime() + 29 * 24 * 3_600_000)),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/readiness/programs', { body: { ...f, title: f.title.trim() } })),
    {
      invalidate: [keys.readinessAll],
      onDone: () => {
        toast.show('Program started.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="New readiness program"
      description="A season, an event or an emergency, over the days you state: Ramadan and Eid move, so the days are yours to give."
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Start
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label="Kind" error={fieldError(save.error, 'kind')}>
          {(p) => (
            <Select {...p} value={f.kind} onChange={set('kind')}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Title" error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} placeholder="Ramadan 2027" />}
        </Field>
        <div className="form__row">
          <Field label="First day" error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label="Last day" error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Readiness programs (ADR 0067): seasons, events and emergencies, prepared item by item. */
export default function ReadinessPage() {
  const { ready, can } = usePermissions();
  const [filters, setFilters] = useState<{ kind: ReadinessProgram['kind'] | ''; open: 'true' | 'false' | '' }>({
    kind: '',
    open: 'true',
  });
  const [creating, setCreating] = useState(false);
  const list = useCursorList(keys.readinessPrograms(filters), (c) => fetchers.readinessPrograms(filters, c), {
    enabled: can('readiness.manage'),
  });
  if (ready && !can('readiness.manage'))
    return (
      <>
        <PageHeader title="Readiness" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Readiness"
        description="Seasons, events and emergencies: their tasks, estimates, contract reviews and inspection campaigns."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New program
          </Button>
        }
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as typeof filters.kind })}>
          <option value="">Every kind</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </Select>
        <Select value={filters.open} onChange={(e) => setFilters({ ...filters, open: e.target.value as typeof filters.open })}>
          <option value="true">Open</option>
          <option value="false">Closed</option>
          <option value="">Open or closed</option>
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ReadinessProgram>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No program"
            columns={[
              { key: 't', header: 'Program', cell: (p) => <Link href={`/readiness/${p.id}`}>{p.title}</Link> },
              { key: 'k', header: 'Kind', cell: (p) => humanize(p.kind) },
              { key: 'd', header: 'Days', cell: (p) => `${formatDate(p.startsOn)} – ${formatDate(p.endsOn)}` },
              {
                key: 'r',
                header: 'Ready',
                cell: (p) => (p.readiness.percent === null ? '—' : `${p.readiness.percent}%`),
              },
              { key: 'o', header: 'Open items', cell: (p) => p.readiness.open },
              { key: 'b', header: 'Budget (EGP)', cell: (p) => p.readiness.budget },
              { key: 's', header: 'Status', cell: (p) => (p.closedAt ? 'Closed' : 'Open') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewProgramDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
