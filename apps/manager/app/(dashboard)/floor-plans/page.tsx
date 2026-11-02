'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FloorPlanSummary } from '@/lib/queries';

function NewPlanDialog({ onClose }: { onClose: () => void }) {
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
        toast.show('Floor plan added. Now draw its units.');
        router.push(`/floor-plans/${p.id}`);
      },
    },
  );
  const ready = buildingId !== '' && floor !== '' && Number.isInteger(Number(floor)) && fileId !== null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a floor plan"
      description="One image per building and floor."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Building" error={fieldError(save.error, 'buildingId')}>
          {(p) => (
            <Select {...p} value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
              <option value="">Select…</option>
              {(buildings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Floor" hint="-5 to 200." error={fieldError(save.error, 'floor')}>
          {(p) => <Input {...p} type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />}
        </Field>
        <FileUpload purpose="floor_plan" label={fileId ? 'Image uploaded — replace' : 'Upload the image'} onUploaded={(id) => setFileId(id)} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The buildings' floor plans (ADR 0084), by building and floor. */
export default function FloorPlansPage() {
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: keys.floorPlans, queryFn: fetchers.floorPlans, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Floor plans" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Floor plans"
        description="A plan per building floor, with a box for each unit. A household sees its own floor’s plan with its own unit marked, never another."
      />
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          Add a floor plan
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FloorPlanSummary>
            rows={list.data?.data ?? []}
            rowKey={(p) => p.id}
            empty="No floor plan"
            columns={[
              {
                key: 'building',
                header: 'Building',
                cell: (p) => (
                  <Link className="table__link" href={`/floor-plans/${p.id}`}>
                    {p.buildingName}
                  </Link>
                ),
              },
              { key: 'floor', header: 'Floor', cell: (p) => p.floor },
              { key: 'units', header: 'Units drawn', cell: (p) => p.hotspots },
            ]}
          />
        </QueryState>
      </Card>
      {adding ? <NewPlanDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
