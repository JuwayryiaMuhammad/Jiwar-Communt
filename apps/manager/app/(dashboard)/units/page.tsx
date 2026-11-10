'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BuildingsCard, UnitImportDialog } from '@/components/units/register';
import { REVIEW_LABELS } from '@/components/units/review-labels';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { clean, fetchers, keys, type Unit, type UnitFilters, type UnitNeedingReview } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/units-list';
import en from '@/messages/en/units-list';

const TABS = ['all', 'review', 'buildings'] as const;
const STATES = ['vacant', 'occupied', 'closed'] as const;

function NewUnitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('added', { code: unit.code }));
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
      title={t('newUnit')}
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.code.trim()}>
            {t('addUnit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('code')} hint={t('codeHint')} error={fieldError(create.error, 'code')}>
          {(p) => <Input {...p} autoFocus value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />}
        </Field>
        <div className="form__row">
          <Field label={c('building')} error={fieldError(create.error, 'building')}>
            {(p) => <Input {...p} value={form.building} onChange={(e) => setForm({ ...form, building: e.target.value })} />}
          </Field>
          <Field label={c('floor')} error={fieldError(create.error, 'floor')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { can } = usePermissions();
  const manages = can('units.manage');
  const [filters, setFilters] = useState<UnitFilters>({});
  const [csvError, setCsvError] = useState<unknown>(null);
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: () => fetchers.buildings(), enabled: manages });
  const list = useCursorList(keys.unitsFiltered(filters), (cursor) => fetchers.unitsFiltered(filters, cursor));
  return (
    <div className="stack">
      <div className="form__row">
        <Field label={c('search')}>
          {(p) => (
            <Input
              {...p}
              placeholder={t('searchPlaceholder')}
              value={filters.q ?? ''}
              onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })}
            />
          )}
        </Field>
        {manages ? (
          <>
            <Field label={c('building')}>
              {(p) => (
                <Select {...p} value={filters.buildingId ?? ''} onChange={(e) => setFilters({ ...filters, buildingId: e.target.value || undefined })}>
                  <option value="">{t('any')}</option>
                  {(buildings.data?.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={c('status')}>
              {(p) => (
                <Select
                  {...p}
                  value={filters.status ?? ''}
                  onChange={(e) => setFilters({ ...filters, status: (e.target.value || undefined) as UnitFilters['status'] })}
                >
                  <option value="">{t('any')}</option>
                  {STATES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
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
              {t('csv')}
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
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'code',
                header: c('unit'),
                cell: (u) => (
                  <Link className="table__link" href={`/units/${u.id}`}>
                    {u.code}
                  </Link>
                ),
              },
              { key: 'building', header: c('building'), cell: (u) => u.building ?? '—' },
              { key: 'floor', header: c('floor'), cell: (u) => <span className="t-num">{u.floor ?? '—'}</span> },
              { key: 'created', header: t('col.added'), cell: (u) => fmt.date(u.createdAt) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </div>
  );
}

function NeedingReview() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const reviewText = useLabel(REVIEW_LABELS);
  const list = useCursorList(keys.unitsReview, (cursor) => fetchers.unitsReview(cursor));
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<UnitNeedingReview>
          rows={list.rows}
          rowKey={(r) => r.flagId}
          empty={t('reviewEmpty')}
          emptyHint={t('reviewEmptyHint')}
          columns={[
            {
              key: 'code',
              header: c('unit'),
              cell: (r) => (
                <Link className="table__link" href={`/units/${r.unitId}`}>
                  {r.code}
                </Link>
              ),
            },
            { key: 'reason', header: c('reason'), cell: (r) => <Badge tone="terracotta">{reviewText(r.reason)}</Badge> },
            { key: 'occupants', header: t('col.occupants'), cell: (r) => <span className="t-num">{fmt.number(r.activeOccupants)}</span> },
            { key: 'when', header: t('col.flagged'), cell: (r) => <span title={fmt.dateTime(r.flaggedAt)}>{fmt.relative(r.flaggedAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

function UnitsView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'all');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const { can } = usePermissions();
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Segmented
              label={t('title')}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: t('tab.all') },
                { value: 'review', label: t('tab.review') },
                ...(can('units.manage') ? [{ value: 'buildings' as const, label: t('tab.buildings') }] : []),
              ]}
            />
            {can('units.manage') ? (
              <Button icon={<Upload aria-hidden />} onClick={() => setImporting(true)}>
                {t('import')}
              </Button>
            ) : null}
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              {t('newUnit')}
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
