'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Box = { unitId: string; x: number; y: number; width: number; height: number };
const round = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100_000) / 100_000));

/**
 * A floor plan and its units' boxes (ADR 0084): pick a unit of the floor,
 * then click two opposite corners on the image. Saved whole; a box past the
 * edge is refused (HOTSPOT_OUTSIDE_IMAGE). A unit moved off the floor since
 * shows as misplaced.
 */
export default function FloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const plan = useQuery({ queryKey: keys.floorPlan(id), queryFn: () => fetchers.floorPlan(id), enabled: allowed });
  const units = useQuery({
    queryKey: ['units', 'of-building', plan.data?.buildingId],
    queryFn: () =>
      unwrap(api.GET('/api/v1/units', { params: { query: { buildingId: plan.data!.buildingId, limit: 100 } } })),
    enabled: allowed && plan.data !== undefined,
  });
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [unitId, setUnitId] = useState('');
  const [corner, setCorner] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (plan.data) setBoxes(plan.data.units.map((u) => ({ unitId: u.unitId, x: u.x, y: u.y, width: u.width, height: u.height })));
  }, [plan.data]);
  const save = useAction(
    () => unwrap(api.PUT('/api/v1/staff/floor-plans/{id}/hotspots', { params: { path: { id } }, body: { hotspots: boxes } })),
    { invalidate: [keys.spacesAll], onDone: () => toast.show('The units are saved on the plan.') },
  );
  const setImage = useAction(
    (fileId: string) => unwrap(api.PUT('/api/v1/staff/floor-plans/{id}/image', { params: { path: { id } }, body: { fileId } })),
    { invalidate: [keys.spacesAll], onDone: () => toast.show('The image is replaced; the boxes stay where they were.') },
  );
  const remove = useAction(() => unwrap(api.DELETE('/api/v1/staff/floor-plans/{id}', { params: { path: { id } } })), {
    invalidate: [keys.spacesAll],
    onDone: () => {
      toast.show('Floor plan removed.');
      router.push('/floor-plans');
    },
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Floor plan" />
        <ForbiddenState />
      </>
    );
  const onFloor = (units.data?.data ?? []).filter((u) => u.floor === plan.data?.floor);
  const codeOf = (uid: string) =>
    onFloor.find((u) => u.id === uid)?.code ?? plan.data?.units.find((u) => u.unitId === uid)?.unitCode ?? uid;
  const misplaced = new Set((plan.data?.units ?? []).filter((u) => u.misplaced).map((u) => u.unitId));
  return (
    <QueryState query={plan}>
      {plan.data ? (
        <>
          <PageHeader
            title={`${plan.data.buildingName} · floor ${plan.data.floor}`}
            description="Pick a unit, then click two opposite corners of its box on the plan."
          />
          <Card>
            <div className="stack">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Select value={unitId} onChange={(e) => (setUnitId(e.target.value), setCorner(null))} aria-label="Unit to draw">
                  <option value="">Pick a unit of this floor…</option>
                  {onFloor.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code}
                    </option>
                  ))}
                </Select>
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  Save the units
                </Button>
                <FileUpload purpose="floor_plan" label="Replace the image" disabled={setImage.isPending} onUploaded={(f) => setImage.mutateAsync(f).then(() => undefined)} />
                <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Remove the plan
                </Button>
              </div>
              {plan.data.image ? (
                <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={plan.data.image.url}
                    alt={`Floor ${plan.data.floor} of ${plan.data.buildingName}`}
                    style={{ maxWidth: '100%', display: 'block', cursor: unitId ? 'crosshair' : 'default' }}
                    onClick={(e) => {
                      if (!unitId) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const at = { x: round((e.clientX - r.left) / r.width), y: round((e.clientY - r.top) / r.height) };
                      if (!corner) return setCorner(at);
                      const box = {
                        unitId,
                        x: Math.min(corner.x, at.x),
                        y: Math.min(corner.y, at.y),
                        width: round(Math.abs(at.x - corner.x)),
                        height: round(Math.abs(at.y - corner.y)),
                      };
                      setCorner(null);
                      if (box.width > 0 && box.height > 0) setBoxes([...boxes.filter((b) => b.unitId !== unitId), box]);
                    }}
                  />
                  {boxes.map((b) => (
                    <button
                      type="button"
                      key={b.unitId}
                      title={`${codeOf(b.unitId)} — remove`}
                      onClick={() => setBoxes(boxes.filter((x) => x !== b))}
                      style={{
                        position: 'absolute',
                        left: `${b.x * 100}%`,
                        top: `${b.y * 100}%`,
                        width: `${b.width * 100}%`,
                        height: `${b.height * 100}%`,
                        border: `2px solid ${misplaced.has(b.unitId) ? 'var(--terracotta, #b5543c)' : 'var(--ink, #222)'}`,
                        background: 'transparent',
                        fontSize: 11,
                      }}
                    >
                      {codeOf(b.unitId)}
                    </button>
                  ))}
                </div>
              ) : null}
              {misplaced.size ? (
                <p>
                  <Badge tone="terracotta">Misplaced</Badge> These units are on another floor now: draw them on their own floor’s plan.
                </p>
              ) : null}
              <ErrorAlert error={save.error ?? setImage.error ?? remove.error} />
            </div>
          </Card>
        </>
      ) : null}
    </QueryState>
  );
}
