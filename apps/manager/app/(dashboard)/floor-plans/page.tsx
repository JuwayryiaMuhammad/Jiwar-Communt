'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FloorPlanSummary } from '@/lib/queries';
import ar from '@/messages/ar/fac-places';
import en from '@/messages/en/fac-places';

function NewPlanDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const router = useRouter();
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: fetchers.buildings });
  const [buildingId, setBuildingId] = useState('');
  const [floor, setFloor] = useState('');
  const [fileId, setFileId] = useState<string | null>(null);
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/floor-plans', { body: { buildingId, floor: Number(floor), fileId: fileId! } })),
    {
      invalidate: [keys.spacesAll],
      onDone: (p) => {
        toast.show(t('plans.added'));
        router.push(`/floor-plans/${p.id}`);
      },
    },
  );
  const ready = buildingId !== '' && floor !== '' && Number.isInteger(Number(floor)) && fileId !== null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('plans.addTitle')}
      description={t('plans.addDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('building')} error={fieldError(save.error, 'buildingId')}>
          {(p) => (
            <Select {...p} value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
              <option value="">{c('select')}</option>
              {(buildings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={c('floor')} hint={t('plans.floorHint')} error={fieldError(save.error, 'floor')}>
          {(p) => <Input {...p} type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />}
        </Field>
        <FileUpload purpose="floor_plan" label={fileId ? t('plans.imageUploaded') : t('plans.uploadImage')} onUploaded={(id) => setFileId(id)} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The buildings' floor plans (ADR 0084), by building and floor. */
export default function FloorPlansPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: keys.floorPlans, queryFn: fetchers.floorPlans, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('plans.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('plans.title')}
        description={t('plans.description')}
      />
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('plans.add')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FloorPlanSummary>
            rows={list.data?.data ?? []}
            rowKey={(p) => p.id}
            empty={t('plans.empty')}
            columns={[
              {
                key: 'building',
                header: c('building'),
                cell: (p) => (
                  <Link className="table__link" href={`/floor-plans/${p.id}`}>
                    {p.buildingName}
                  </Link>
                ),
              },
              { key: 'floor', header: c('floor'), cell: (p) => f.number(p.floor) },
              { key: 'units', header: t('plans.col.unitsDrawn'), cell: (p) => f.number(p.hotspots) },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <NewPlanDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
