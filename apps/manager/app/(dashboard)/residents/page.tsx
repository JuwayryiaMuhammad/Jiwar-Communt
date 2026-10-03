'use client';

import { humanize, unwrap, type Schema } from '@jiwar/api';
import {
  emptyPerson,
  ErrorAlert,
  fieldError,
  LoadMore,
  PersonFields,
  personPayload,
  QueryState,
  useAction,
  useCursorList,
  type Person,
} from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, StatusBadge, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { emptyOccupancy, OccupancyRow } from '@/components/occupancy-row';
import { api } from '@/lib/api';
import { fetchers, keys, type Resident } from '@/lib/queries';

type OccupancyInput = Schema<'OccupancyInputDto'>;

function NewResidentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [person, setPerson] = useState<Person>(emptyPerson);
  const [units, setUnits] = useState<OccupancyInput[]>([emptyOccupancy]);
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/residents', {
          body: {
            ...personPayload(person),
            units: units.filter((u) => u.unitId),
          },
        }),
      ),
    {
      invalidate: [keys.residents, keys.units],
      onDone: (r) => {
        toast.show(`${r.fullName ?? 'Resident'} added. They sign in with a code sent to their email.`);
        close();
        router.push(`/residents/${r.id}`);
      },
    },
  );
  function close() {
    setPerson(emptyPerson);
    setUnits([emptyOccupancy]);
    create.reset();
    onClose();
  }
  return (
    <Dialog
      wide
      open={open}
      onClose={close}
      title="New resident"
      description="Creates the resident's account and their occupancy of one or more units."
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!units.some((u) => u.unitId)}>
            Add resident
          </Button>
        </>
      }
    >
      <div className="form">
        <PersonFields value={person} onChange={setPerson} error={create.error} />
        <p className="form__section">Units</p>
        {units.map((u, i) => (
          <OccupancyRow
            key={i}
            value={u}
            error={fieldError(create.error, `units.${i}`)}
            onChange={(v) => setUnits(units.map((x, j) => (j === i ? v : x)))}
            onRemove={units.length > 1 ? () => setUnits(units.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        <div>
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setUnits([...units, emptyOccupancy])}>
            Another unit
          </Button>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

export default function ResidentsPage() {
  const [creating, setCreating] = useState(false);
  const list = useCursorList(keys.residents, (c) => fetchers.residents(c));
  return (
    <>
      <PageHeader
        title="Residents"
        description="Owners and tenants with an account in the compound."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New resident
          </Button>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Resident>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No residents yet"
            columns={[
              {
                key: 'name',
                header: 'Resident',
                cell: (r) =>
                  r.erased ? (
                    <span className="t-secondary">Erased account</span>
                  ) : (
                    <Link className="table__link" href={`/residents/${r.id}`}>
                      {r.fullName}
                    </Link>
                  ),
              },
              {
                key: 'contact',
                header: 'Contact',
                cell: (r) =>
                  r.erased ? null : (
                    <div>
                      <div>{r.email}</div>
                      <div className="list__meta t-num">{r.phone ?? 'Phone released'}</div>
                    </div>
                  ),
              },
              {
                key: 'units',
                header: 'Units',
                cell: (r) => (
                  <span className="chip-list">
                    {(r.units ?? []).map((u) => (
                      <Badge key={u.unitId} tone={u.isPrimary ? 'green' : 'beige'} plain>
                        {u.unitCode} · {humanize(u.occupancyType)}
                        {u.isPrimary ? ' · primary' : ''}
                      </Badge>
                    ))}
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.erased ? 'erased' : r.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewResidentDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
