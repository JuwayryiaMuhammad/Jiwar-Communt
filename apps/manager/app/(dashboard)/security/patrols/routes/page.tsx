'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { moved, patrolScheduleText, timesFrom } from '@/components/patrols/logic';
import { postBody, postName, WEEKDAYS } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolRoute, type PatrolRouteDetail } from '@/lib/queries';

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
function VersionFields({ form, onChange, errorOf }: { form: VersionForm; onChange: (f: VersionForm) => void; errorOf: (field: string) => string | undefined }) {
  const checkpoints = useQuery({ queryKey: keys.checkpoints('active'), queryFn: () => fetchers.checkpoints('active') });
  const all = checkpoints.data?.data ?? [];
  const name = (id: string) => all.find((c) => c.id === id)?.nameEn ?? id;
  const [pick, setPick] = useState('');
  return (
    <>
      <Field label="Checkpoints, in the order walked" error={errorOf('checkpointIds')}>
        {(p) => (
          <div className="row">
            <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{checkpoints.isPending ? 'Loading checkpoints…' : 'Add a checkpoint…'}</option>
              {all
                .filter((c) => !form.checkpointIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn} · {postName(c.post)}
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
              Add
            </Button>
          </div>
        )}
      </Field>
      <ol className="stack stack--sm">
        {form.checkpointIds.map((id, i) => (
          <li key={id} className="row">
            <span className="t-num">{i + 1}.</span>
            <span>{name(id)}</span>
            <Button size="sm" variant="text" iconOnly aria-label="Up" icon={<ArrowUp aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: moved(form.checkpointIds, i, -1) })} />
            <Button size="sm" variant="text" iconOnly aria-label="Down" icon={<ArrowDown aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: moved(form.checkpointIds, i, 1) })} />
            <Button size="sm" variant="text" iconOnly aria-label="Remove" icon={<X aria-hidden />} onClick={() => onChange({ ...form, checkpointIds: form.checkpointIds.filter((c) => c !== id) })} />
          </li>
        ))}
      </ol>
      <Checkbox label="Scanned in this order" checked={form.ordered} onChange={(e) => onChange({ ...form, ordered: e.target.checked })} />
      <Field label="Expected minutes" hint="5 to 480. A run under way twice as long is closed as timed out." error={errorOf('expectedMinutes')}>
        {(p) => <Input {...p} inputMode="numeric" value={form.expectedMinutes} onChange={(e) => onChange({ ...form, expectedMinutes: e.target.value })} />}
      </Field>
      <Checkbox label="On a weekly schedule" checked={form.scheduled} onChange={(e) => onChange({ ...form, scheduled: e.target.checked })} />
      {form.scheduled ? (
        <>
          <div className="row">
            {WEEKDAYS.map((d, i) => (
              <Checkbox
                key={d}
                label={d}
                checked={form.days.includes(i)}
                onChange={(e) => onChange({ ...form, days: e.target.checked ? [...form.days, i] : form.days.filter((x) => x !== i) })}
              />
            ))}
          </div>
          <Field
            label="Start times"
            hint="HH:MM, separated by commas. Each run may be started from 15 minutes before until its window (its minutes, 30 at least) ends; windows never overlap."
            error={errorOf('schedule.times') ?? errorOf('schedule.days')}
          >
            {(p) => <Input {...p} placeholder="08:00, 14:00, 22:00" value={form.times} onChange={(e) => onChange({ ...form, times: e.target.value })} />}
          </Field>
        </>
      ) : null}
    </>
  );
}

function NewRouteDialog({ onClose }: { onClose: () => void }) {
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
        toast.show('Route added. Its scheduled runs are made a week ahead.');
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
      title="New route"
      description="Walked from a gate or a zone."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add route
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Post" error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
          {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
        </Field>
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <VersionFields form={form} onChange={setForm} errorOf={(f) => fieldError(save.error, `version.${f}`)} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ChangeDialog({ route, onClose }: { route: PatrolRouteDetail; onClose: () => void }) {
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
        toast.show('Route changed. Its runs nobody started are made again.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Change ${route.nameEn}`}
      description="A new version: the scheduled runs nobody started are cancelled and made again from it; a run under way keeps its version."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={version === null}>
            Save version {route.version.number + 1}
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
      title="Rename route"
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function RouteDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const route = useQuery({ queryKey: keys.route(id), queryFn: () => fetchers.route(id) });
  const [mode, setMode] = useState<'view' | 'change' | 'rename' | 'retire'>('view');
  const retire = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/patrols/routes/{id}/retire', { params: { path: { id } } })),
    {
      invalidate: [keys.routesAll, keys.checkpointsAll, keys.runsAll],
      onDone: () => {
        toast.show('Route retired. Its scheduled runs are cancelled.');
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
        title={r?.nameEn ?? 'Route'}
        footer={
          <>
            {r && !r.retiredAt ? (
              <>
                <Button onClick={() => setMode('rename')}>Rename</Button>
                <Button onClick={() => setMode('change')}>Change</Button>
                <Button onClick={() => setMode('retire')}>Retire</Button>
              </>
            ) : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={route} rows={4}>
          {r ? (
            <dl className="dl">
              <dt>Post</dt>
              <dd>{postName(r.post)}</dd>
              <dt>Version</dt>
              <dd>
                {r.version.number} · since {formatDateTime(r.version.createdAt)}
              </dd>
              <dt>Schedule</dt>
              <dd>{patrolScheduleText(r.version.schedule)}</dd>
              <dt>Takes</dt>
              <dd>
                {r.version.expectedMinutes} min · window {r.version.windowMinutes} min · {r.version.ordered ? 'in order' : 'any order'}
              </dd>
              <dt>Checkpoints</dt>
              <dd>
                <ol>
                  {r.stops.map((s) => (
                    <li key={s.checkpointId}>
                      {s.nameEn}
                      {s.retired ? <span className="t-secondary"> · retired since</span> : null}
                    </li>
                  ))}
                </ol>
              </dd>
              {r.retiredAt ? (
                <>
                  <dt>Retired</dt>
                  <dd>{formatDateTime(r.retiredAt)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </QueryState>
      </Dialog>
      <ConfirmDialog
        open={mode === 'retire'}
        onClose={() => setMode('view')}
        title={`Retire ${r?.nameEn ?? 'this route'}?`}
        description="For good: its scheduled runs nobody started are cancelled; a run under way finishes."
        confirmLabel="Retire"
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
        <PageHeader title="Patrol routes" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Patrol routes" description="Each change is a new version; a run keeps the version it started with." />
      <div className="toolbar">
        <Segmented<View>
          label="Routes shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: 'In service' },
            { value: 'retired', label: 'Retired' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          New route
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PatrolRoute>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No route"
            columns={[
              {
                key: 'name',
                header: 'Route',
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r.id)}>
                    {r.nameEn}
                  </Button>
                ),
              },
              { key: 'post', header: 'Post', cell: (r) => postName(r.post) },
              { key: 'points', header: 'Checkpoints', cell: (r) => <span className="t-num">{r.version.checkpoints}</span> },
              { key: 'when', header: 'Schedule', cell: (r) => patrolScheduleText(r.version.schedule) },
              { key: 'takes', header: 'Minutes', cell: (r) => <span className="t-num">{r.version.expectedMinutes}</span> },
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
