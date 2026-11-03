'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceItem } from '@/lib/queries';

/** What the compound keeps valid (ADR 0087). */
const COMPLIANCE_KINDS = ['fire_system', 'lift', 'insurance', 'licence', 'permit', 'other'] as const;
type Kind = (typeof COMPLIANCE_KINDS)[number] | '';

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const accounts = useQuery({ queryKey: [...keys.accounts, 'owners'], queryFn: () => fetchers.accounts(undefined, 100) });
  const vendors = useQuery({ queryKey: keys.vendors({ status: 'active' }), queryFn: () => fetchers.vendors({ status: 'active' }, undefined, 100) });
  const owners = (accounts.data?.data ?? []).filter((a) => !a.erased && a.status === 'active' && (a.type === 'staff' || a.type === 'manager'));
  const [f, setF] = useState({
    kind: 'fire_system' as (typeof COMPLIANCE_KINDS)[number],
    title: '',
    authority: '',
    reference: '',
    ownerId: '',
    vendorId: '',
    recurrenceMonths: '12',
    firstDueOn: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/compliance/items', {
          body: {
            kind: f.kind,
            title: f.title.trim(),
            firstDueOn: f.firstDueOn,
            ...(f.authority.trim() ? { authority: f.authority.trim() } : {}),
            ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
            ...(f.ownerId ? { ownerId: f.ownerId } : {}),
            ...(f.vendorId ? { vendorId: f.vendorId } : {}),
            ...(f.recurrenceMonths ? { recurrenceMonths: Number(f.recurrenceMonths) } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.complianceAll],
      onDone: (item) => {
        toast.show('The item is in the calendar.');
        router.push(`/compliance/${item.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New compliance item"
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.title.trim() || !f.firstDueOn}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="Kind" error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {COMPLIANCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="First due" error={fieldError(save.error, 'firstDueOn')}>
            {(p) => <Input {...p} type="date" value={f.firstDueOn} onChange={set('firstDueOn')} />}
          </Field>
        </div>
        <Field label="Title" error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <div className="form__row">
          <Field label="Authority" hint="Who issues it." error={fieldError(save.error, 'authority')}>
            {(p) => <Input {...p} value={f.authority} onChange={set('authority')} />}
          </Field>
          <Field label="Reference" error={fieldError(save.error, 'reference')}>
            {(p) => <Input {...p} value={f.reference} onChange={set('reference')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Staff member" hint="Told when it is near." error={fieldError(save.error, 'ownerId')}>
            {(p) => (
              <Select {...p} value={f.ownerId} onChange={set('ownerId')}>
                <option value="">Nobody</option>
                {owners.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Vendor" error={fieldError(save.error, 'vendorId')}>
            {(p) => (
              <Select {...p} value={f.vendorId} onChange={set('vendorId')}>
                <option value="">None</option>
                {(vendors.data?.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.reference} · {v.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Every how many months" hint="Empty: once." error={fieldError(save.error, 'recurrenceMonths')}>
          {(p) => <Input {...p} inputMode="numeric" value={f.recurrenceMonths} onChange={set('recurrenceMonths')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The compliance calendar's items and where they stand (ADR 0087). */
export default function CompliancePage() {
  const { ready, can } = usePermissions();
  const allowed = can('compliance.manage');
  const [kind, setKind] = useState<Kind>('');
  const [creating, setCreating] = useState(false);
  const [csvError, setCsvError] = useState<unknown>(null);
  const filters = { kind, status: 'active' as const };
  const list = useCursorList(keys.complianceItems(filters), (c) => fetchers.complianceItems(filters, c), { enabled: allowed });
  const report = useQuery({ queryKey: keys.complianceReport, queryFn: fetchers.complianceReport, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Compliance" />
        <ForbiddenState />
      </>
    );
  const t = report.data?.totals;
  return (
    <>
      <PageHeader
        title="Compliance"
        description="Fire systems, lifts, insurance, licences and permits: who answers for each, when it is due, and its evidence."
        actions={
          <>
            <Button onClick={() => download('/api/v1/staff/compliance/report/export', {}, 'compliance-status.csv').catch(setCsvError)}>
              Export CSV
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New item
            </Button>
          </>
        }
      />
      <ErrorAlert error={csvError} />
      {t && report.data ? (
        <div className="grid grid--stats">
          <Stat label="Valid" value={t.valid} />
          <Stat label="Due soon" value={t.dueSoon} />
          <Stat label="Overdue" value={t.overdue} />
          <Stat label="Done once" value={t.completed} />
          <Stat label="Vendor papers lapsed" value={report.data.vendorPapers.expired} />
        </div>
      ) : null}
      <div className="toolbar">
        <Segmented<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[{ value: '', label: 'All' }, ...COMPLIANCE_KINDS.map((k) => ({ value: k, label: humanize(k) }))]}
        />
      </div>
      <Card flush>
        <CardHeader title="Items" />
        <QueryState query={list}>
          <DataTable<ComplianceItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No compliance item"
            columns={[
              {
                key: 't',
                header: 'Item',
                cell: (i) => (
                  <Link className="table__link" href={`/compliance/${i.id}`}>
                    {i.title}
                  </Link>
                ),
              },
              { key: 'k', header: 'Kind', cell: (i) => humanize(i.kind) },
              { key: 's', header: 'State', cell: (i) => humanize(i.state) },
              { key: 'd', header: 'Due', cell: (i) => (i.current ? formatDate(i.current.dueOn) : '—') },
              { key: 'v', header: 'Answers for it', cell: (i) => [i.vendor?.name, i.owner?.fullName].filter(Boolean).join(' · ') || '—' },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewItemDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
