'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Button, Card, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Kind = 'building' | 'gate' | 'facility';
type Point = { kind: Kind; refId: string; x: number; y: number };

/** A click on the image, as fractions of its width and height (ADR 0084). */
function fractionOf(e: {
  clientX: number;
  clientY: number;
  currentTarget: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } };
}): { x: number; y: number } {
  const r = e.currentTarget.getBoundingClientRect();
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100_000) / 100_000));
  return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
}

/**
 * The compound's site map (ADR 0084): one image, and a point for each of
 * its buildings, gates and facilities, placed by a click. Saved whole.
 */
export default function SiteMapPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const map = useQuery({ queryKey: keys.siteMap, queryFn: fetchers.siteMap, enabled: allowed });
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: fetchers.buildings, enabled: allowed });
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates, enabled: allowed && can('gate.read') });
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: allowed && can('facilities.manage') });
  const [points, setPoints] = useState<Point[]>([]);
  const [placing, setPlacing] = useState('');
  useEffect(() => {
    if (map.data) setPoints(map.data.points.map((p) => ({ kind: p.kind as Kind, refId: p.refId, x: p.x, y: p.y })));
  }, [map.data]);
  const setImage = useAction(
    (fileId: string) => unwrap(api.PUT('/api/v1/staff/site-map/image', { body: { fileId } })),
    { invalidate: [keys.siteMap], onDone: () => toast.show('The site map’s image is set. Its points stay where they were.') },
  );
  const save = useAction(() => unwrap(api.PUT('/api/v1/staff/site-map/points', { body: { points } })), {
    invalidate: [keys.siteMap],
    onDone: () => toast.show('The points are saved.'),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Site map" />
        <ForbiddenState />
      </>
    );
  const places: { key: string; kind: Kind; id: string; name: string }[] = [
    ...(buildings.data?.data ?? []).map((b) => ({ key: `building:${b.id}`, kind: 'building' as const, id: b.id, name: b.name })),
    ...(gates.data?.data ?? []).map((g) => ({ key: `gate:${g.id}`, kind: 'gate' as const, id: g.id, name: g.name })),
    ...(facilities.data?.data ?? [])
      .filter((f) => f.active)
      .map((f) => ({ key: `facility:${f.id}`, kind: 'facility' as const, id: f.id, name: f.nameEn })),
  ];
  const nameOf = (p: Point) => places.find((x) => x.key === `${p.kind}:${p.refId}`)?.name ?? p.refId;
  return (
    <>
      <PageHeader
        title="Site map"
        description="One image of the compound, with its buildings, gates and facilities on it. Residents see it with the active places."
      />
      <QueryState query={map}>
        <Card>
          <div className="stack">
            <FileUpload purpose="site_map" label={map.data?.image ? 'Replace the image' : 'Upload the image'} disabled={setImage.isPending} onUploaded={(id) => setImage.mutateAsync(id).then(() => undefined)} />
            {map.data?.image ? (
              <>
                <div className="row" style={{ gap: 8 }}>
                  <Select value={placing} onChange={(e) => setPlacing(e.target.value)} aria-label="Place to put on the map">
                    <option value="">Pick a place, then click the map…</option>
                    {places.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.kind}: {p.name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                    Save the points
                  </Button>
                </div>
                <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={map.data.image.url}
                    alt="The compound’s site map"
                    style={{ maxWidth: '100%', display: 'block', cursor: placing ? 'crosshair' : 'default' }}
                    onClick={(e) => {
                      const place = places.find((p) => p.key === placing);
                      if (!place) return;
                      const at = fractionOf(e);
                      setPoints([...points.filter((p) => `${p.kind}:${p.refId}` !== place.key), { kind: place.kind, refId: place.id, ...at }]);
                    }}
                  />
                  {points.map((p) => (
                    <button
                      type="button"
                      key={`${p.kind}:${p.refId}`}
                      title={`${nameOf(p)} — remove`}
                      onClick={() => setPoints(points.filter((q) => q !== p))}
                      style={{
                        position: 'absolute',
                        left: `${p.x * 100}%`,
                        top: `${p.y * 100}%`,
                        transform: 'translate(-50%, -50%)',
                        fontSize: 11,
                        padding: '1px 4px',
                      }}
                    >
                      {nameOf(p)}
                    </button>
                  ))}
                </div>
                <ErrorAlert error={save.error} />
                {fieldError(save.error, 'points') ? <Alert tone="error">{fieldError(save.error, 'points')}</Alert> : null}
              </>
            ) : (
              <p className="muted">Upload the image first; then put the places on it.</p>
            )}
            <ErrorAlert error={setImage.error} />
          </div>
        </Card>
      </QueryState>
    </>
  );
}
