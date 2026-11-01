'use client';

import { formatDate, formatDateTime, humanize, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BuildingsCard, UnitImportDialog } from '@/components/units/register';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { REVIEW_TEXT } from '@/lib/labels';
import { usePermissions } from '@/lib/permissions';
import { clean, fetchers, keys, type Unit, type UnitFilters, type UnitNeedingReview } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['all', 'review', 'buildings'] as const;
const STATES = ['vacant', 'occupied', 'closed'] as const;

function NewUnitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [form, setForm] = useState({ code: '', building: '', floor: '' });
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/units', {
          body: {
            code: form.code.trim(),
            ...(form.building.trim() ? { building: form.building.trim() } : {}),
            ...(form.floor.trim() ? { floor: Number(form.floor) } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.units],
      onDone: (unit) => {
        toast.show(`Unit ${unit.code} added.`);
        close();
        router.push(`/units/${unit.id}`);
      },
    },
  );
  function close() {
    setForm({ code: '', building: '', floor: '' });
    create.reset();
    onClose();
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New unit"
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.code.trim()}>
            Add unit
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Code" hint="As written on the door, e.g. A-101." error={fieldError(create.error, 'code')}>
          {(p) => <Input {...p} autoFocus value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />}
        </Field>
        <div className="form__row">
          <Field label="Building" error={fieldError(create.error, 'building')}>
            {(p) => <Input {...p} value={form.building} onChange={(e) => setForm({ ...form, building: e.target.value })} />}
          </Field>
          <Field label="Floor" error={fieldError(create.error, 'floor')}>
            {(p) => (
              <Input {...p} type="number" inputMode="numeric" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />
            )}
          </Field>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

/** The register (ADR 0072): by code, building, where a unit stands and who holds it; the same as CSV. */
function AllUnits() {
  const { can } = usePermissions();
  const manages = can('units.manage');
  const [filters, setFilters] = useState<UnitFilters>({});
  const [csvError, setCsvError] = useState<unknown>(null);
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: () => fetchers.buildings(), enabled: manages });
  const list = useCursorList(keys.unitsFiltered(filters), (c) => fetchers.unitsFiltered(filters, c));
  return (
    <div className="stack">
      <div className="form__row">
        <Field label="Search">
          {(p) => (
            <Input {...p} placeholder="Part of the code" value={filters.q ?? ''} onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })} />
          )}
        </Field>
        {manages ? (
          <>
            <Field label="Building">
              {(p) => (
                <Select {...p} value={filters.buildingId ?? ''} onChange={(e) => setFilters({ ...filters, buildingId: e.target.value || undefined })}>
                  <option value="">Any</option>
                  {(buildings.data?.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {(p) => (
                <Select
                  {...p}
                  value={filters.status ?? ''}
                  onChange={(e) => setFilters({ ...filters, status: (e.target.value || undefined) as UnitFilters['status'] })}
                >
                  <option value="">Any</option>
                  {STATES.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              icon={<Download aria-hidden />}
              onClick={() => {
                setCsvError(null);
                download('/api/v1/staff/units/export', clean(filters), 'units.csv').catch(setCsvError);
              }}
            >
              CSV
            </Button>
          </>
        ) : null}
      </div>
      <ErrorAlert error={csvError} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Unit>
            rows={list.rows}
            rowKey={(u) => u.id}
            empty="No units match"
            emptyHint="Add the compound's units so residents can be assigned to them."
            columns={[
              {
                key: 'code',
                header: 'Unit',
                cell: (u) => (
                  <Link className="table__link" href={`/units/${u.id}`}>
                    {u.code}
                  </Link>
                ),
              },
              { key: 'building', header: 'Building', cell: (u) => u.building ?? '—' },
              { key: 'floor', header: 'Floor', cell: (u) => <span className="t-num">{u.floor ?? '—'}</span> },
              { key: 'created', header: 'Added', cell: (u) => formatDate(u.createdAt) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </div>
  );
}

function NeedingReview() {
  const list = useCursorList(keys.unitsReview, (c) => fetchers.unitsReview(c));
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<UnitNeedingReview>
          rows={list.rows}
          rowKey={(r) => r.flagId}
          empty="No unit is under review"
          emptyHint="A unit is flagged when its primary resident leaves, is frozen or dies, or a separation is reported."
          columns={[
            {
              key: 'code',
              header: 'Unit',
              cell: (r) => (
                <Link className="table__link" href={`/units/${r.unitId}`}>
                  {r.code}
                </Link>
              ),
            },
            { key: 'reason', header: 'Reason', cell: (r) => <Badge tone="terracotta">{REVIEW_TEXT[r.reason] ?? humanize(r.reason)}</Badge> },
            { key: 'occupants', header: 'Active occupants', cell: (r) => <span className="t-num">{r.activeOccupants}</span> },
            { key: 'when', header: 'Flagged', cell: (r) => <span title={formatDateTime(r.flaggedAt)}>{relativeTime(r.flaggedAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

function UnitsView() {
  const [tab, setTab] = useTab(TABS, 'all');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const { can } = usePermissions();
  return (
    <>
      <PageHeader
        title="Units"
        description="Apartments, villas and shops in the compound."
        actions={
          <>
            <Segmented
              label="Units"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: 'All units' },
                { value: 'review', label: 'Under review' },
                ...(can('units.manage') ? [{ value: 'buildings' as const, label: 'Buildings' }] : []),
              ]}
            />
            {can('units.manage') ? (
              <Button icon={<Upload aria-hidden />} onClick={() => setImporting(true)}>
                Import
              </Button>
            ) : null}
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              New unit
            </Button>
          </>
        }
      />
      {tab === 'all' ? <AllUnits /> : tab === 'review' ? <NeedingReview /> : <BuildingsCard />}
      <NewUnitDialog open={creating} onClose={() => setCreating(false)} />
      {importing ? <UnitImportDialog onClose={() => setImporting(false)} /> : null}
    </>
  );
}

export default function UnitsPage() {
  return (
    <Suspense>
      <UnitsView />
    </Suspense>
  );
}
