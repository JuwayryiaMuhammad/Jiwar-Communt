'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Route = Schema<'BusRouteView'>;
type Album = Schema<'StaffGalleryAlbumView'>;
type Tab = 'prayer' | 'buses' | 'gallery';
const KEY = ['daily-life'] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const METHODS = ['egyptian', 'muslim_world_league', 'umm_al_qura', 'karachi', 'dubai', 'qatar', 'kuwait'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

/** Where the compound is, for its prayer times (computed on read, locally). */
function Prayer() {
  const toast = useToast();
  const settings = useQuery({ queryKey: [...KEY, 'prayer'], queryFn: () => unwrap(api.GET('/api/v1/community/prayer-settings')) });
  const [f, setF] = useState({ latitude: '', longitude: '', prayerMethod: 'egyptian', asrMadhab: 'shafi' });
  useEffect(() => {
    if (settings.data)
      setF({
        latitude: settings.data.latitude ?? '',
        longitude: settings.data.longitude ?? '',
        prayerMethod: settings.data.prayerMethod,
        asrMadhab: settings.data.asrMadhab,
      });
  }, [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/community/prayer-settings', {
          body: {
            latitude: f.latitude.trim() || null,
            longitude: f.longitude.trim() || null,
            prayerMethod: f.prayerMethod as (typeof METHODS)[number],
            asrMadhab: f.asrMadhab as 'shafi' | 'hanafi',
          },
        }),
      ),
    { invalidate: [KEY], onDone: () => toast.show('Saved: residents see the day’s times.') },
  );
  return (
    <Card>
      <CardHeader title="Prayer times" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label="Latitude" hint="Degrees, e.g. 30.044420. Both or neither." error={fieldError(save.error, 'latitude')}>
              {(p) => <Input {...p} inputMode="decimal" value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} />}
            </Field>
            <Field label="Longitude" hint="Degrees, e.g. 31.235712." error={fieldError(save.error, 'longitude')}>
              {(p) => <Input {...p} inputMode="decimal" value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} />}
            </Field>
            <Field label="Calculation method">
              {(p) => (
                <Select {...p} value={f.prayerMethod} onChange={(e) => setF({ ...f, prayerMethod: e.target.value })}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {label(m)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Asr">
              {(p) => (
                <Select {...p} value={f.asrMadhab} onChange={(e) => setF({ ...f, asrMadhab: e.target.value })}>
                  <option value="shafi">Shafi, Maliki, Hanbali</option>
                  <option value="hanafi">Hanafi</option>
                </Select>
              )}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                Save
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/** The buses' timetable: routes and their departures. */
function Buses() {
  const toast = useToast();
  const routes = useQuery({ queryKey: [...KEY, 'buses'], queryFn: () => unwrap(api.GET('/api/v1/community/bus-routes')) });
  const [name, setName] = useState({ en: '', ar: '' });
  const add = useAction(() => unwrap(api.POST('/api/v1/community/bus-routes', { body: { nameEn: name.en.trim(), nameAr: name.ar.trim() } })), {
    invalidate: [KEY],
    onDone: () => {
      toast.show('Route added.');
      setName({ en: '', ar: '' });
    },
  });
  const retire = useAction((r: Route) => unwrap(api.PATCH('/api/v1/community/bus-routes/{id}', { params: { path: { id: r.id } }, body: { active: !r.active } })), {
    invalidate: [KEY],
  });
  const [dep, setDep] = useState({ routeId: '', time: '', fromStop: '', toStop: '', weekdays: [0, 1, 2, 3, 4] as number[] });
  const addDeparture = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/community/bus-routes/{id}/departures', {
          params: { path: { id: dep.routeId } },
          body: { weekdays: dep.weekdays, time: dep.time, fromStop: dep.fromStop.trim(), toStop: dep.toStop.trim() },
        }),
      ),
    { invalidate: [KEY], onDone: () => toast.show('Departure added.') },
  );
  const remove = useAction((id: string) => unwrap(api.DELETE('/api/v1/community/bus-departures/{id}', { params: { path: { id } } })), {
    invalidate: [KEY],
  });
  return (
    <div className="stack">
      <Card>
        <CardHeader title="New route" />
        <CardBody>
          <div className="form">
            <Field label="Name (English)" error={fieldError(add.error, 'nameEn')}>
              {(p) => <Input {...p} value={name.en} onChange={(e) => setName({ ...name, en: e.target.value })} />}
            </Field>
            <Field label="Name (Arabic)" error={fieldError(add.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" value={name.ar} onChange={(e) => setName({ ...name, ar: e.target.value })} />}
            </Field>
            <div>
              <Button variant="primary" loading={add.isPending} disabled={!name.en.trim() || !name.ar.trim()} onClick={() => add.mutate(undefined)}>
                Add route
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="New departure" />
        <CardBody>
          <div className="form">
            <Field label="Route">
              {(p) => (
                <Select {...p} value={dep.routeId} onChange={(e) => setDep({ ...dep, routeId: e.target.value })}>
                  <option value="">Choose…</option>
                  {routes.data?.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.nameEn}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Time" hint="The compound’s time of day." error={fieldError(addDeparture.error, 'time')}>
              {(p) => <Input {...p} type="time" value={dep.time} onChange={(e) => setDep({ ...dep, time: e.target.value })} />}
            </Field>
            <Field label="Days">
              {() => (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {DAYS.map((d, i) => (
                    <Button
                      key={d}
                      size="sm"
                      variant={dep.weekdays.includes(i) ? 'primary' : undefined}
                      onClick={() =>
                        setDep({ ...dep, weekdays: dep.weekdays.includes(i) ? dep.weekdays.filter((x) => x !== i) : [...dep.weekdays, i].sort() })
                      }
                    >
                      {d}
                    </Button>
                  ))}
                </span>
              )}
            </Field>
            <Field label="From" error={fieldError(addDeparture.error, 'fromStop')}>
              {(p) => <Input {...p} value={dep.fromStop} onChange={(e) => setDep({ ...dep, fromStop: e.target.value })} />}
            </Field>
            <Field label="To" error={fieldError(addDeparture.error, 'toStop')}>
              {(p) => <Input {...p} value={dep.toStop} onChange={(e) => setDep({ ...dep, toStop: e.target.value })} />}
            </Field>
            <div>
              <Button
                variant="primary"
                loading={addDeparture.isPending}
                disabled={!dep.routeId || !dep.time || !dep.weekdays.length || !dep.fromStop.trim() || !dep.toStop.trim()}
                onClick={() => addDeparture.mutate(undefined)}
              >
                Add departure
              </Button>
            </div>
            <ErrorAlert error={addDeparture.error} />
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <QueryState query={routes}>
          <DataTable<Route>
            rows={routes.data?.data}
            rowKey={(r) => r.id}
            empty="No routes"
            columns={[
              { key: 'n', header: 'Route', cell: (r) => r.nameEn },
              {
                key: 'd',
                header: 'Departures',
                cell: (r) =>
                  r.departures.length ? (
                    <span className="stack" style={{ gap: 4 }}>
                      {r.departures.map((d) => (
                        <span key={d.id} className="row" style={{ gap: 8 }}>
                          <span className="t-num">{d.time}</span> {d.weekdays.map((w) => DAYS[w]).join(' ')} · {d.fromStop} → {d.toStop}
                          <Button size="sm" onClick={() => remove.mutate(d.id)}>
                            Remove
                          </Button>
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { key: 's', header: 'Status', cell: (r) => <Badge tone={r.active ? 'green' : 'beige'}>{r.active ? 'Running' : 'Retired'}</Badge> },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" onClick={() => retire.mutate(r)}>
                    {r.active ? 'Retire' : 'Run again'}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={add.error ?? retire.error ?? remove.error} />
    </div>
  );
}

/** The gallery: albums, their photos, publishing, and hiding reported ones. */
function Gallery() {
  const toast = useToast();
  const albums = useQuery({ queryKey: [...KEY, 'gallery'], queryFn: () => unwrap(api.GET('/api/v1/community/gallery/albums')) });
  const [title, setTitle] = useState({ en: '', ar: '' });
  const create = useAction(() => unwrap(api.POST('/api/v1/community/gallery/albums', { body: { titleEn: title.en.trim(), titleAr: title.ar.trim() } })), {
    invalidate: [KEY],
    onDone: () => {
      toast.show('Album started: add photos, then publish.');
      setTitle({ en: '', ar: '' });
    },
  });
  const publish = useAction((id: string) => unwrap(api.POST('/api/v1/community/gallery/albums/{id}/publish', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show('Published: residents see it.'),
  });
  const hide = useAction((id: string) => unwrap(api.POST('/api/v1/community/gallery/photos/{id}/hide', { params: { path: { id } }, body: { reasonCode: REASON_CODES.galleryPhotoHide[0] } })), {
    invalidate: [KEY],
  });
  const restore = useAction((id: string) => unwrap(api.POST('/api/v1/community/gallery/photos/{id}/restore', { params: { path: { id } } })), {
    invalidate: [KEY],
  });
  return (
    <div className="stack">
      <Card>
        <CardHeader title="New album" />
        <CardBody>
          <div className="form">
            <Field label="Title (English)" error={fieldError(create.error, 'titleEn')}>
              {(p) => <Input {...p} value={title.en} onChange={(e) => setTitle({ ...title, en: e.target.value })} />}
            </Field>
            <Field label="Title (Arabic)" error={fieldError(create.error, 'titleAr')}>
              {(p) => <Input {...p} dir="rtl" value={title.ar} onChange={(e) => setTitle({ ...title, ar: e.target.value })} />}
            </Field>
            <div>
              <Button variant="primary" loading={create.isPending} disabled={!title.en.trim() || !title.ar.trim()} onClick={() => create.mutate(undefined)}>
                Start album
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
      <QueryState query={albums}>
        <div className="stack">
          {albums.data?.data.map((a: Album) => (
            <Card key={a.id}>
              <CardHeader title={a.titleEn} />
              <CardBody>
                <div className="stack">
                  <span className="t-secondary">{a.publishedAt ? `Published ${formatDateTime(a.publishedAt)}` : 'Draft'}</span>
                  {a.photos.map((p) => (
                    <span key={p.id} className="row" style={{ gap: 8 }}>
                      {p.url ? <img src={p.url} alt={p.caption ?? ''} style={{ width: 96, height: 64, objectFit: 'cover' }} /> : null}
                      <span>{p.caption ?? '—'}</span>
                      {p.hiddenReason ? <Badge tone="error">{label(p.hiddenReason)}</Badge> : null}
                      {p.reports ? <Badge tone="beige">{`${p.reports} report(s)`}</Badge> : null}
                      {p.hiddenReason ? (
                        <Button size="sm" onClick={() => restore.mutate(p.id)}>
                          Show again
                        </Button>
                      ) : (
                        <Button size="sm" variant="danger" onClick={() => hide.mutate(p.id)}>
                          Hide
                        </Button>
                      )}
                    </span>
                  ))}
                  <FileUpload
                    purpose="gallery_photo"
                    label="Add a photo"
                    onUploaded={async (fileId) => {
                      await unwrap(api.POST('/api/v1/community/gallery/albums/{id}/photos', { params: { path: { id: a.id } }, body: { fileId } }));
                      toast.show('Photo added.');
                      await albums.refetch();
                    }}
                  />
                  {!a.publishedAt ? (
                    <div>
                      <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate(a.id)}>
                        Publish
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      </QueryState>
      <ErrorAlert error={create.error ?? publish.error ?? hide.error ?? restore.error} />
    </div>
  );
}

/**
 * Daily life (ADR 0071): where the compound is for its prayer times, the
 * buses' timetable and the gallery. All `content.manage`.
 */
export default function DailyLifePage() {
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('prayer');
  if (ready && !can('content.manage'))
    return (
      <>
        <PageHeader title="Daily life" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Daily life" description="Prayer times, the buses and the gallery residents see." />
      <div className="stack">
        <Segmented
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'prayer', label: 'Prayer times' },
            { value: 'buses', label: 'Buses' },
            { value: 'gallery', label: 'Gallery' },
          ]}
        />
        {tab === 'prayer' ? <Prayer /> : tab === 'buses' ? <Buses /> : <Gallery />}
      </div>
    </>
  );
}
