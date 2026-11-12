'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
  Textarea,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw } from 'lucide-react';
import { Suspense, useMemo, useState } from 'react';
import { DateRange, endOfDay, startOfDay } from '@/components/date-range';
import { Places } from '@/components/safety/places';
import { usePersonName } from '@/components/management-requests/bits';
import { usePermissions } from '@/lib/permissions';
import { api } from '@/lib/api';
import { fetchers, keys, type Entry, type Gate, type Inside } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/gate-main';
import en from '@/messages/en/gate-main';

const TABS = ['entries', 'inside', 'gates', 'places'] as const;
type Tab = (typeof TABS)[number];
type GateKind = Gate['kind'];

/** Entries may be backdated up to 24 h (offline guards); flag a large gap. */
const LATE_MS = 10 * 60 * 1000;

/** Who came in, as the gate log words it (Permits: ADR 0049; field exceptions: ADR 0056). */
const SUBJECTS = [
  'visitor_pass',
  'worker_engagement',
  'gate_request',
  'permit_worker',
  'event_guest',
  'move_permit',
  'field_exception',
] as const satisfies readonly Entry['subjectType'][];

const EMPTY = { gateId: '', direction: '', subjectType: '', from: '', to: '' };

function Entries({ gates }: { gates: Gate[] }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const personName = usePersonName();
  const [filters, setFilters] = useState(EMPTY);
  const names = useMemo(() => new Map(gates.map((g) => [g.id, g.name])), [gates]);
  const query = {
    gateId: filters.gateId || undefined,
    direction: (filters.direction || undefined) as Entry['direction'] | undefined,
    subjectType: (filters.subjectType || undefined) as Entry['subjectType'] | undefined,
    from: startOfDay(filters.from),
    to: endOfDay(filters.to),
  };
  const list = useCursorList(keys.entries(query), (cursor) => fetchers.entries(query, cursor), { refetchInterval: 30_000 });
  const dirty = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="toolbar">
        <Field label={t('gate')}>
          {(p) => (
            <Select {...p} value={filters.gateId} onChange={(e) => setFilters({ ...filters, gateId: e.target.value })}>
              <option value="">{t('allGates')}</option>
              {gates.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('direction')}>
          {(p) => (
            <Select {...p} value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })}>
              <option value="">{t('inAndOut')}</option>
              <option value="in">{t('in')}</option>
              <option value="out">{t('out')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('who')}>
          {(p) => (
            <Select {...p} value={filters.subjectType} onChange={(e) => setFilters({ ...filters, subjectType: e.target.value })}>
              <option value="">{t('everyone')}</option>
              {SUBJECTS.map((v) => (
                <option key={v} value={v}>
                  {t(`subject.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DateRange from={filters.from} to={filters.to} onChange={(r) => setFilters({ ...filters, ...r })} />
        {dirty ? (
          <Button variant="text" icon={<RotateCcw aria-hidden />} onClick={() => setFilters(EMPTY)} style={{ height: 40 }}>
            {t('reset')}
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Entry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={dirty ? t('emptyFiltered') : t('empty')}
            columns={[
              {
                key: 'when',
                header: t('col.when'),
                cell: (e) => {
                  const late = new Date(e.recordedAt).getTime() - new Date(e.occurredAt).getTime() > LATE_MS;
                  return (
                    <div>
                      <div className="t-num" style={{ whiteSpace: 'nowrap' }}>
                        {f.dateTime(e.occurredAt)}
                      </div>
                      {late ? (
                        <div className="list__meta" title={t('recordedHint')}>
                          {t('recorded', { when: f.dateTime(e.recordedAt) })}
                        </div>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'dir',
                header: t('direction'),
                cell: (e) => <Badge tone={e.direction === 'in' ? 'green' : 'beige'}>{e.direction === 'in' ? t('in') : t('out')}</Badge>,
              },
              { key: 'who', header: t('who'), cell: (e) => t(`subject.${e.subjectType}`) },
              { key: 'unit', header: c('unit'), cell: (e) => <span className="table__primary">{e.unitCode}</span> },
              { key: 'gate', header: t('col.gate'), cell: (e) => names.get(e.gateId) ?? '—' },
              {
                key: 'method',
                header: t('col.how'),
                cell: (e) => (
                  <span className="row">
                    {label(e.method)}
                    {e.unconfirmed ? <Badge tone="terracotta">{t('unconfirmed')}</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'guard',
                header: t('col.guard'),
                cell: (e) => (e.guard ? personName(e.guard) : <span className="t-secondary">{t('system')}</span>),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}

/**
 * Who is inside now, at every gate (ADR 0056's update): an entry with no exit
 * yet, newest first, read with `gate.read` and no shift. No name: a visitor
 * is a pass, a unit and, when the guard took one, a photo (a presigned link,
 * so the list is read again every 30 s and never stored).
 */
function InsideNow() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const list = useCursorList(keys.gateInside, (cursor) => fetchers.gateInside(cursor), { refetchInterval: 30_000 });
  return (
    <>
      <p className="t-secondary">{t('insideIntro')}</p>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Inside>
            rows={list.rows}
            rowKey={(i) => `${i.subjectType}:${i.subjectId}`}
            empty={t('emptyInside')}
            columns={[
              {
                key: 'since',
                header: t('col.since'),
                cell: (i) => (
                  <div>
                    <div className="t-num" style={{ whiteSpace: 'nowrap' }}>
                      {f.dateTime(i.enteredAt)}
                    </div>
                    <div className="list__meta">{f.relative(i.enteredAt)}</div>
                  </div>
                ),
              },
              {
                key: 'who',
                header: t('who'),
                cell: (i) => (
                  <div>
                    {t(`subject.${i.subjectType}`)}
                    {i.permitReference ? <div className="list__meta t-num">{i.permitReference}</div> : null}
                  </div>
                ),
              },
              { key: 'unit', header: c('unit'), cell: (i) => <span className="table__primary">{i.unitCode}</span> },
              { key: 'gate', header: t('col.gate'), cell: (i) => i.gateName },
              {
                key: 'count',
                header: t('col.count'),
                cell: (i) => (i.partySize > 1 ? t('insideOf', { inside: i.insideCount, party: i.partySize }) : i.insideCount),
              },
              {
                key: 'photo',
                header: t('col.photo'),
                cell: (i) =>
                  i.photo ? (
                    // A short-lived presigned link: opened in a new tab, never stored.
                    <a href={i.photo.url} target="_blank" rel="noreferrer" title={t('photoAlt')}>
                      <img
                        src={i.photo.url}
                        alt={t('photoAlt')}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, display: 'block' }}
                      />
                    </a>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}

function GateDialog({ gate, open, onClose }: { gate: Gate | null; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [name, setName] = useState(gate?.name ?? '');
  const [kind, setKind] = useState<GateKind>(gate?.kind ?? 'mixed');
  const [phone, setPhone] = useState(gate?.phone ?? '');
  // How a visitor reaches it from outside (ADR 0071), on their page.
  const [directionsEn, setDirectionsEn] = useState(gate?.directionsEn ?? '');
  const [directionsAr, setDirectionsAr] = useState(gate?.directionsAr ?? '');
  const save = useAction(
    () =>
      gate
        ? unwrap(
            api.PATCH('/api/v1/gates/{id}', {
              params: { path: { id: gate.id } },
              // Empty removes the phone.
              body: {
                name: name.trim(),
                kind,
                phone: phone.trim() || null,
                directionsEn: directionsEn.trim() || null,
                directionsAr: directionsAr.trim() || null,
              },
            }),
          )
        : unwrap(api.POST('/api/v1/gates', { body: { name: name.trim(), kind, ...(phone.trim() ? { phone: phone.trim() } : {}) } })),
    {
      invalidate: [keys.gates],
      onDone: (g) => {
        toast.show(gate ? t('saved', { name: g.name }) : t('added', { name: g.name }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={gate ? t('edit', { name: gate.name }) : t('newGate')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
            {gate ? c('save') : t('addGate')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('name')} hint={t('nameHint')} error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as GateKind)}>
              <option value="mixed">{t('kind.mixed')}</option>
              <option value="pedestrian">{t('kind.pedestrian')}</option>
              <option value="vehicle">{t('kind.vehicle')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('phoneLabel')} hint={t('phoneHint')} error={fieldError(save.error, 'phone')}>
          {(p) => <Input {...p} type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        {gate && (
          <>
            <Field label={t('directionsEn')} hint={t('directionsHint')} error={fieldError(save.error, 'directionsEn')}>
              {(p) => (
                <Textarea {...p} dir="ltr" rows={2} maxLength={500} value={directionsEn} onChange={(e) => setDirectionsEn(e.target.value)} />
              )}
            </Field>
            <Field label={t('directionsAr')} error={fieldError(save.error, 'directionsAr')}>
              {(p) => <Textarea {...p} dir="rtl" rows={2} maxLength={500} value={directionsAr} onChange={(e) => setDirectionsAr(e.target.value)} />}
            </Field>
          </>
        )}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Gates({ query }: { query: { data?: { data: Gate[] }; isPending: boolean; error: unknown } }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [editing, setEditing] = useState<Gate | 'new' | null>(null);
  const toggle = useAction(
    (g: Gate) =>
      unwrap(
        api.PATCH('/api/v1/gates/{id}', {
          params: { path: { id: g.id } },
          body: { status: g.status === 'active' ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.gates],
      onDone: (g) => toast.show(g.status === 'active' ? t('openedForShifts', { name: g.name }) : t('closedForShifts', { name: g.name })),
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          {t('intro')}
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          {t('newGate')}
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={query}>
          <DataTable<Gate>
            rows={query.data?.data}
            rowKey={(g) => g.id}
            empty={t('emptyGates')}
            columns={[
              { key: 'name', header: t('col.gate'), cell: (g) => <span className="table__primary">{g.name}</span> },
              { key: 'kind', header: c('kind'), cell: (g) => t(`kind.${g.kind}`) },
              {
                key: 'phone',
                header: c('phone'),
                cell: (g) => (g.phone ? <span className="t-num ltr">{g.phone}</span> : <span className="t-secondary">—</span>),
              },
              { key: 'status', header: c('status'), cell: (g) => <StatusBadge status={g.status} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (g) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(g)}>
                      {c('edit')}
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === g.id} onClick={() => toggle.mutate(g)}>
                      {g.status === 'active' ? t('deactivate') : t('activate')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? (
        <GateDialog gate={editing === 'new' ? null : editing} open onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function GateView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'entries');
  const { can } = usePermissions();
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates });
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Segmented<Tab>
            label={t('title')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'entries', label: t('tab.entries') },
              ...(can('gate.read') ? [{ value: 'inside' as const, label: t('tab.inside') }] : []),
              { value: 'gates', label: t('tab.gates') },
              ...(can('gate.manage') ? [{ value: 'places' as const, label: t('tab.places') }] : []),
            ]}
          />
        }
      />
      {tab === 'entries' ? (
        <Entries gates={gates.data?.data ?? []} />
      ) : tab === 'inside' && can('gate.read') ? (
        <InsideNow />
      ) : tab === 'places' && can('gate.manage') ? (
        <Places />
      ) : (
        <Gates query={gates} />
      )}
    </>
  );
}

export default function GatePage() {
  return (
    <Suspense>
      <GateView />
    </Suspense>
  );
}
