'use client';

import { unwrap, type Schema } from '@jiwar/api';
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
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { emptyOccupancy, OccupancyRow } from '@/components/occupancy-row';
import { api } from '@/lib/api';
import { fetchers, keys, type Resident } from '@/lib/queries';
import ar from '@/messages/ar/res-residents';
import en from '@/messages/en/res-residents';

type OccupancyInput = Schema<'OccupancyInputDto'>;

function NewResidentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('added', { name: r.fullName ?? t('residentFallback') }));
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
      title={t('newResident')}
      description={t('newDescription')}
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!units.some((u) => u.unitId)}>
            {t('addResident')}
          </Button>
        </>
      }
    >
      <div className="form">
        <PersonFields value={person} onChange={setPerson} error={create.error} />
        <p className="form__section">{t('unitsSection')}</p>
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
            {t('anotherUnit')}
          </Button>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

export default function ResidentsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const [creating, setCreating] = useState(false);
  const list = useCursorList(keys.residents, (cursor) => fetchers.residents(cursor));
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            {t('newResident')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Resident>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('none')}
            columns={[
              {
                key: 'name',
                header: t('col.resident'),
                cell: (r) =>
                  r.erased ? (
                    <span className="t-secondary">{t('erasedAccount')}</span>
                  ) : (
                    <Link className="table__link" href={`/residents/${r.id}`}>
                      {r.fullName}
                    </Link>
                  ),
              },
              {
                key: 'contact',
                header: t('col.contact'),
                cell: (r) =>
                  r.erased ? null : (
                    <div>
                      <div className="ltr">{r.email}</div>
                      <div className="list__meta t-num ltr">{r.phone ?? t('phoneReleased')}</div>
                    </div>
                  ),
              },
              {
                key: 'units',
                header: t('col.units'),
                cell: (r) => (
                  <span className="chip-list">
                    {(r.units ?? []).map((u) => (
                      <Badge key={u.unitId} tone={u.isPrimary ? 'green' : 'beige'} plain>
                        {u.isPrimary
                          ? t('unitLinePrimary', { unit: u.unitCode, type: label(u.occupancyType) })
                          : `${u.unitCode} · ${label(u.occupancyType)}`}
                      </Badge>
                    ))}
                  </span>
                ),
              },
              { key: 'status', header: c('status'), cell: (r) => <StatusBadge status={r.erased ? 'erased' : r.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewResidentDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
