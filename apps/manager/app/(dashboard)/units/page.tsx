'use client';

import { formatDate, formatDateTime, humanize, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, Input, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { REVIEW_TEXT } from '@/lib/labels';
import { fetchers, keys, type Unit, type UnitNeedingReview } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['all', 'review'] as const;

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

function AllUnits() {
  const list = useCursorList(keys.units, (c) => fetchers.units(c));
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<Unit>
          rows={list.rows}
          rowKey={(u) => u.id}
          empty="No units yet"
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
              ]}
            />
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              New unit
            </Button>
          </>
        }
      />
      {tab === 'all' ? <AllUnits /> : <NeedingReview />}
      <NewUnitDialog open={creating} onClose={() => setCreating(false)} />
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
