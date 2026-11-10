'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/daily-life';
import en from '@/messages/en/daily-life';

type Route = Schema<'BusRouteView'>;
type Album = Schema<'StaffGalleryAlbumView'>;
type Tab = 'prayer' | 'buses' | 'gallery';
const KEY = ['daily-life'] as const;
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const METHODS = ['egyptian', 'muslim_world_league', 'umm_al_qura', 'karachi', 'dubai', 'qatar', 'kuwait'] as const;

/** Where the compound is, for its prayer times (computed on read, locally). */
function Prayer() {
  const t = useT(en, ar);
  const c = useCommonT();
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
    { invalidate: [KEY], onDone: () => toast.show(t('prayer.saved')) },
  );
  return (
    <Card>
      <CardHeader title={t('prayer.title')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label={t('prayer.latitude')} hint={t('prayer.latitudeHint')} error={fieldError(save.error, 'latitude')}>
              {(p) => <Input {...p} className="ltr" inputMode="decimal" value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} />}
            </Field>
            <Field label={t('prayer.longitude')} hint={t('prayer.longitudeHint')} error={fieldError(save.error, 'longitude')}>
              {(p) => <Input {...p} className="ltr" inputMode="decimal" value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} />}
            </Field>
            <Field label={t('prayer.method')}>
              {(p) => (
                <Select {...p} value={f.prayerMethod} onChange={(e) => setF({ ...f, prayerMethod: e.target.value })}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`method.${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('prayer.asr')}>
              {(p) => (
                <Select {...p} value={f.asrMadhab} onChange={(e) => setF({ ...f, asrMadhab: e.target.value })}>
                  <option value="shafi">{t('prayer.shafi')}</option>
                  <option value="hanafi">{t('prayer.hanafi')}</option>
                </Select>
              )}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                {c('save')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const routes = useQuery({ queryKey: [...KEY, 'buses'], queryFn: () => unwrap(api.GET('/api/v1/community/bus-routes')) });
  const [name, setName] = useState({ en: '', ar: '' });
  const add = useAction(() => unwrap(api.POST('/api/v1/community/bus-routes', { body: { nameEn: name.en.trim(), nameAr: name.ar.trim() } })), {
    invalidate: [KEY],
    onDone: () => {
      toast.show(t('buses.routeAdded'));
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
    { invalidate: [KEY], onDone: () => toast.show(t('buses.departureAdded')) },
  );
  const remove = useAction((id: string) => unwrap(api.DELETE('/api/v1/community/bus-departures/{id}', { params: { path: { id } } })), {
    invalidate: [KEY],
  });
  return (
    <div className="stack">
      <Card>
        <CardHeader title={t('buses.newRoute')} />
        <CardBody>
          <div className="form">
            <Field label={t('buses.nameEn')} error={fieldError(add.error, 'nameEn')}>
              {(p) => <Input {...p} value={name.en} onChange={(e) => setName({ ...name, en: e.target.value })} />}
            </Field>
            <Field label={t('buses.nameAr')} error={fieldError(add.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" value={name.ar} onChange={(e) => setName({ ...name, ar: e.target.value })} />}
            </Field>
            <div>
              <Button variant="primary" loading={add.isPending} disabled={!name.en.trim() || !name.ar.trim()} onClick={() => add.mutate(undefined)}>
                {t('buses.addRoute')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('buses.newDeparture')} />
        <CardBody>
          <div className="form">
            <Field label={t('buses.route')}>
              {(p) => (
                <Select {...p} value={dep.routeId} onChange={(e) => setDep({ ...dep, routeId: e.target.value })}>
                  <option value="">{t('buses.choose')}</option>
                  {routes.data?.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {locale === 'ar' ? r.nameAr : r.nameEn}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('buses.time')} hint={t('buses.timeHint')} error={fieldError(addDeparture.error, 'time')}>
              {(p) => <Input {...p} className="ltr" type="time" value={dep.time} onChange={(e) => setDep({ ...dep, time: e.target.value })} />}
            </Field>
            <Field label={t('buses.days')}>
              {() => (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {DAYS.map((i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant={dep.weekdays.includes(i) ? 'primary' : undefined}
                      onClick={() =>
                        setDep({ ...dep, weekdays: dep.weekdays.includes(i) ? dep.weekdays.filter((x) => x !== i) : [...dep.weekdays, i].sort() })
                      }
                    >
                      {f.weekday(i, 'short')}
                    </Button>
                  ))}
                </span>
              )}
            </Field>
            <Field label={c('from')} error={fieldError(addDeparture.error, 'fromStop')}>
              {(p) => <Input {...p} value={dep.fromStop} onChange={(e) => setDep({ ...dep, fromStop: e.target.value })} />}
            </Field>
            <Field label={c('to')} error={fieldError(addDeparture.error, 'toStop')}>
              {(p) => <Input {...p} value={dep.toStop} onChange={(e) => setDep({ ...dep, toStop: e.target.value })} />}
            </Field>
            <div>
              <Button
                variant="primary"
                loading={addDeparture.isPending}
                disabled={!dep.routeId || !dep.time || !dep.weekdays.length || !dep.fromStop.trim() || !dep.toStop.trim()}
                onClick={() => addDeparture.mutate(undefined)}
              >
                {t('buses.addDeparture')}
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
            empty={t('buses.empty')}
            columns={[
              { key: 'n', header: t('buses.route'), cell: (r) => (locale === 'ar' ? r.nameAr : r.nameEn) },
              {
                key: 'd',
                header: t('buses.departures'),
                cell: (r) =>
                  r.departures.length ? (
                    <span className="stack" style={{ gap: 4 }}>
                      {r.departures.map((d) => (
                        <span key={d.id} className="row" style={{ gap: 8 }}>
                          <span className="t-num ltr">{d.time}</span> {d.weekdays.map((w) => f.weekday(w, 'short')).join(' ')} · {d.fromStop} <ArrowRight size={14} aria-hidden className="icon-dir" /> {d.toStop}
                          <Button size="sm" onClick={() => remove.mutate(d.id)}>
                            {c('remove')}
                          </Button>
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { key: 's', header: c('status'), cell: (r) => <Badge tone={r.active ? 'green' : 'beige'}>{r.active ? t('buses.running') : t('buses.retired')}</Badge> },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" onClick={() => retire.mutate(r)}>
                    {r.active ? t('buses.retire') : t('buses.runAgain')}
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
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const albums = useQuery({ queryKey: [...KEY, 'gallery'], queryFn: () => unwrap(api.GET('/api/v1/community/gallery/albums')) });
  const [title, setTitle] = useState({ en: '', ar: '' });
  const create = useAction(() => unwrap(api.POST('/api/v1/community/gallery/albums', { body: { titleEn: title.en.trim(), titleAr: title.ar.trim() } })), {
    invalidate: [KEY],
    onDone: () => {
      toast.show(t('gallery.albumStarted'));
      setTitle({ en: '', ar: '' });
    },
  });
  const publish = useAction((id: string) => unwrap(api.POST('/api/v1/community/gallery/albums/{id}/publish', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show(t('gallery.published')),
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
        <CardHeader title={t('gallery.newAlbum')} />
        <CardBody>
          <div className="form">
            <Field label={t('gallery.titleEn')} error={fieldError(create.error, 'titleEn')}>
              {(p) => <Input {...p} value={title.en} onChange={(e) => setTitle({ ...title, en: e.target.value })} />}
            </Field>
            <Field label={t('gallery.titleAr')} error={fieldError(create.error, 'titleAr')}>
              {(p) => <Input {...p} dir="rtl" value={title.ar} onChange={(e) => setTitle({ ...title, ar: e.target.value })} />}
            </Field>
            <div>
              <Button variant="primary" loading={create.isPending} disabled={!title.en.trim() || !title.ar.trim()} onClick={() => create.mutate(undefined)}>
                {t('gallery.startAlbum')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
      <QueryState query={albums}>
        <div className="stack">
          {albums.data?.data.map((a: Album) => (
            <Card key={a.id}>
              <CardHeader title={locale === 'ar' ? a.titleAr : a.titleEn} />
              <CardBody>
                <div className="stack">
                  <span className="t-secondary">{a.publishedAt ? t('gallery.publishedOn', { date: f.dateTime(a.publishedAt) }) : t('gallery.draft')}</span>
                  {a.photos.map((p) => (
                    <span key={p.id} className="row" style={{ gap: 8 }}>
                      {p.url ? <img src={p.url} alt={p.caption ?? ''} style={{ width: 96, height: 64, objectFit: 'cover' }} /> : null}
                      <span>{p.caption ?? '—'}</span>
                      {p.hiddenReason ? <Badge tone="error">{label(p.hiddenReason)}</Badge> : null}
                      {p.reports ? <Badge tone="beige">{t('gallery.reports', { count: p.reports })}</Badge> : null}
                      {p.hiddenReason ? (
                        <Button size="sm" onClick={() => restore.mutate(p.id)}>
                          {t('gallery.showAgain')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="danger" onClick={() => hide.mutate(p.id)}>
                          {t('gallery.hide')}
                        </Button>
                      )}
                    </span>
                  ))}
                  <FileUpload
                    purpose="gallery_photo"
                    label={t('gallery.addPhoto')}
                    onUploaded={async (fileId) => {
                      await unwrap(api.POST('/api/v1/community/gallery/albums/{id}/photos', { params: { path: { id: a.id } }, body: { fileId } }));
                      toast.show(t('gallery.photoAdded'));
                      await albums.refetch();
                    }}
                  />
                  {!a.publishedAt ? (
                    <div>
                      <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate(a.id)}>
                        {t('gallery.publish')}
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
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('prayer');
  if (ready && !can('content.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Segmented
          label={t('section')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'prayer', label: t('tab.prayer') },
            { value: 'buses', label: t('tab.buses') },
            { value: 'gallery', label: t('tab.gallery') },
          ]}
        />
        {tab === 'prayer' ? <Prayer /> : tab === 'buses' ? <Buses /> : <Gallery />}
      </div>
    </>
  );
}
