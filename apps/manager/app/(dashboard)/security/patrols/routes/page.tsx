'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { moved, patrolScheduleText, timesFrom } from '@/components/patrols/logic';
import { nameIn, postBody, postNameIn, WEEKDAYS } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolRoute, type PatrolRouteDetail } from '@/lib/queries';
import ar from '@/messages/ar/guard-routes';
import en from '@/messages/en/guard-routes';

const VIEWS = ['active', 'retired', 'all'] as const;
type View = (typeof VIEWS)[number];

interface VersionForm {
  checkpointIds: string[];
  ordered: boolean;
  expectedMinutes: string;
  scheduled: boolean;
  days: number[];
  times: string;
}

const blank: VersionForm = { checkpointIds: [], ordered: true, expectedMinutes: '30', scheduled: false, days: [], times: '' };

function formOf(r: PatrolRouteDetail): VersionForm {
  return {
    checkpointIds: r.stops.filter((s) => !s.retired).map((s) => s.checkpointId),
    ordered: r.version.ordered,
    expectedMinutes: String(r.version.expectedMinutes),
    scheduled: r.version.schedule !== null,
    days: r.version.schedule?.days ?? [],
    times: (r.version.schedule?.times ?? []).join(', '),
  };
}

/** The version as the API takes it, or null while it is not one. */
function versionBody(f: VersionForm) {
  const minutes = Number(f.expectedMinutes);
  const times = f.scheduled ? timesFrom(f.times) : [];
  if (!f.checkpointIds.length || !Number.isInteger(minutes) || minutes < 5 || minutes > 480) return null;
  if (f.scheduled && (!times || !f.days.length)) return null;
  return {
    checkpointIds: f.checkpointIds,
    ordered: f.ordered,
    expectedMinutes: minutes,
    ...(f.scheduled ? { schedule: { days: [...f.days].sort((a, b) => a - b), times: times ?? [] } } : {}),
  };
}

/** Checkpoints in the order walked, chosen from those in service; and the schedule. */
function VersionFields({ form, onChange, errorOf }: { form: VersionForm; onChange: (f: VersionForm) => void; errorOf: (field: string) => ReactNode }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const checkpoints = useQuery({ queryKey: keys.checkpoints('active'), queryFn: () => fetchers.checkpoints('active') });
  const all = checkpoints.data?.data ?? [];
  const name = (id: string) => {
    const c = all.find((x) => x.id === id);
    return c ? nameIn(c, locale) : id;
  };
  const [pick, setPick] = useState('');
  return (
    <>
      <Field label={t('checkpoints')} error={errorOf('checkpointIds')}>
        {(p) => (
          <div className="row">
            <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{checkpoints.isPending ? t('loadingCheckpoints') : t('addCheckpoint')}</option>
              {all
                .filter((c) => !form.checkpointIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {nameIn(c, locale)} · {postNameIn(c.post, locale)}
                  </option>
                ))}
            </Select>
            <Button
              disabled={!pick}
              onClick={() => {
                onChange({ ...form, checkpointIds: [...form.checkpointIds, pick] });
                setPick('');
              }}
            >
              {t('addButton')}
            </Button>
          </div>
        )}
      </Field>
      <ol className="stack stack--sm">
        {form.checkpointIds.map((id, i) => (
          <li key={id} className="row">
            <span className="t-num">{fmt.number(i + 1)}.</span>
            <span>{name(id)}</span>
            <Button size="sm" variant="text" iconOnly aria-label={t('up')} icon={<ArrowUp aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: moved(form.checkpointIds, i, -1) })} />
            <Button size="sm" variant="text" iconOnly aria-label={t('down')} icon={<ArrowDown aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: moved(form.checkpointIds, i, 1) })} />
            <Button size="sm" variant="text" iconOnly aria-label={t('remove')} icon={<X aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: form.checkpointIds.filter((c) => c !== id) })} />
          </li>
        ))}
      </ol>
      <Checkbox label={t('ordered')} checked={form.ordered} onChange={(e) => onChange({ ...form, ordered: e.target.checked })} />
      <Field label={t('expectedMinutes')} hint={t('expectedMinutesHint')} error={errorOf('expectedMinutes')}>
        {(p) => <Input {...p} dir="ltr" inputMode="numeric" value={form.expectedMinutes} onChange={(e) => onChange({ ...form, expectedMinutes: e.target.value })} />}
      </Field>
      <Checkbox label={t('scheduled')} checked={form.scheduled} onChange={(e) => onChange({ ...form, scheduled: e.target.checked })} />
      {form.scheduled ? (
        <>
          <div className="row">
            {WEEKDAYS.map((d, i) => (
              <Checkbox
                key={d}
                label={fmt.weekday(i, 'short')}
                checked={form.days.includes(i)}
                onChange={(e) => onChange({ ...form, days: e.target.checked ? [...form.days, i] : form.days.filter((x) => x !== i) })}
              />
            ))}
          </div>
          <Field label={t('startTimes')} hint={t('startTimesHint')} error={errorOf('schedule.times') ?? errorOf('schedule.days')}>
            {(p) => <Input {...p} dir="ltr" placeholder="08:00, 14:00, 22:00" value={form.times} onChange={(e) => onChange({ ...form, times: e.target.value })} />}
          </Field>
        </>
      ) : null}
    </>
  );
}

function NewRouteDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [post, setPost] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [form, setForm] = useState<VersionForm>(blank);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const version = versionBody(form);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/patrols/routes', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { ...postBody(post), nameEn: nameEn.trim(), nameAr: nameAr.trim(), version: version! },
        }),
      ),
    {
      invalidate: [keys.routesAll, keys.checkpointsAll, keys.runsAll],
      onDone: () => {
        toast.show(t('added'));
        onClose();
      },
    },
  );
  const ready = postBody(post) !== null && nameEn.trim() !== '' && nameAr.trim() !== '' && version !== null;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('addRoute')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('post')} error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <VersionFields form={form} onChange={setForm} errorOf={(f) => fieldError(save.error, `version.${f}`)} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ChangeDialog({ route, onClose }: { route: PatrolRouteDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const [form, setForm] = useState<VersionForm>(() => formOf(route));
  const version = versionBody(form);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/patrols/routes/{id}/versions', {
          params: { path: { id: route.id } },
          body: version!,
        }),
      ),
    {
      invalidate: [keys.routesAll, keys.checkpointsAll, keys.runsAll],
      onDone: () => {
        toast.show(t('changed'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('changeTitle', { name: nameIn(route, locale) })}
      description={t('changeDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={version === null}>
            {t('saveVersion', { n: route.version.number + 1 })}
          </Button>
        </>
      }
    >
      <div className="form">
        <VersionFields form={form} onChange={setForm} errorOf={(f) => fieldError(save.error, f)} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function RenameDialog({ route, onClose }: { route: PatrolRouteDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const [nameEn, setNameEn] = useState(route.nameEn);
  const [nameAr, setNameAr] = useState(route.nameAr);
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/staff/security/patrols/routes/{id}', { params: { path: { id: route.id } }, body: { nameEn: nameEn.trim(), nameAr: nameAr.trim() } })),
    { invalidate: [keys.routesAll], onDone: onClose },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('renameTitle')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function RouteDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const route = useQuery({ queryKey: keys.route(id), queryFn: () => fetchers.route(id) });
  const [mode, setMode] = useState<'view' | 'change' | 'rename' | 'retire'>('view');
  const retire = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/patrols/routes/{id}/retire', { params: { path: { id } } })),
    {
      invalidate: [keys.routesAll, keys.checkpointsAll, keys.runsAll],
      onDone: () => {
        toast.show(t('retiredToast'));
        onClose();
      },
    },
  );
  const r = route.data;
  if (r && mode === 'change') return <ChangeDialog route={r} onClose={() => setMode('view')} />;
  if (r && mode === 'rename') return <RenameDialog route={r} onClose={() => setMode('view')} />;
  return (
    <>
      <Dialog
        open={mode === 'view'}
        wide
        onClose={onClose}
        title={r ? nameIn(r, locale) : t('route')}
        footer={
          <>
            {r && !r.retiredAt ? (
              <>
                <Button onClick={() => setMode('rename')}>{t('rename')}</Button>
                <Button onClick={() => setMode('change')}>{t('change')}</Button>
                <Button onClick={() => setMode('retire')}>{t('retire')}</Button>
              </>
            ) : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={route} rows={4}>
          {r ? (
            <dl className="dl">
              <dt>{t('post')}</dt>
              <dd>{postNameIn(r.post, locale)}</dd>
              <dt>{t('version')}</dt>
              <dd>{t('versionSince', { n: r.version.number, when: fmt.dateTime(r.version.createdAt) })}</dd>
              <dt>{t('schedule')}</dt>
              <dd>{patrolScheduleText(r.version.schedule, locale)}</dd>
              <dt>{t('takes')}</dt>
              <dd>
                {t('takesText', {
                  minutes: r.version.expectedMinutes,
                  window: r.version.windowMinutes,
                  order: r.version.ordered ? t('inOrder') : t('anyOrder'),
                })}
              </dd>
              <dt>{t('checkpoints')}</dt>
              <dd>
                <ol>
                  {r.stops.map((s) => (
                    <li key={s.checkpointId}>
                      {nameIn(s, locale)}
                      {s.retired ? <span className="t-secondary"> · {t('retiredSince')}</span> : null}
                    </li>
                  ))}
                </ol>
              </dd>
              {r.retiredAt ? (
                <>
                  <dt>{t('retired')}</dt>
                  <dd>{fmt.dateTime(r.retiredAt)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </QueryState>
      </Dialog>
      <ConfirmDialog
        open={mode === 'retire'}
        onClose={() => setMode('view')}
        title={t('retireTitle', { name: r ? nameIn(r, locale) : t('retireThis') })}
        description={t('retireDescription')}
        confirmLabel={t('retire')}
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={() => retire.mutate(undefined)}
      />
    </>
  );
}

/** The routes a patrol walks (ADR 0052): checkpoints in order, how long, when. */
export default function PatrolRoutesPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage');
  const [view, setView] = useState<View>('active');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.routes(status), (c) => fetchers.routes(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View> label={t('shown')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))} />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('add')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PatrolRoute>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'name',
                header: t('col.route'),
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r.id)}>
                    {nameIn(r, locale)}
                  </Button>
                ),
              },
              { key: 'post', header: t('col.post'), cell: (r) => postNameIn(r.post, locale) },
              { key: 'points', header: t('col.checkpoints'), cell: (r) => <span className="t-num">{fmt.number(r.version.checkpoints)}</span> },
              { key: 'when', header: t('col.schedule'), cell: (r) => patrolScheduleText(r.version.schedule, locale) },
              { key: 'takes', header: t('col.minutes'), cell: (r) => <span className="t-num">{fmt.number(r.version.expectedMinutes)}</span> },
              { key: 'state', header: '', cell: (r) => (r.retiredAt ? <StatusBadge status="retired" /> : null) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {adding ? <NewRouteDialog onClose={() => setAdding(false)} /> : null}
      {open ? <RouteDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
