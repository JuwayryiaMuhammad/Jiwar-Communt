'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceContract } from '@/lib/queries';

const KINDS = ['amc', 'service', 'warranty_extension', 'other'] as const;
type Status = MaintenanceContract['status'] | '';

function NewContractDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ code: '', kind: 'amc' as (typeof KINDS)[number], vendorName: '', vendorPhone: '', startsOn: '', endsOn: '', annualValue: '', noticeDays: '30' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/contracts', {
          body: {
            code: f.code.trim(),
            kind: f.kind,
            vendorName: f.vendorName.trim(),
            ...(f.vendorPhone.trim() ? { vendorPhone: f.vendorPhone.trim() } : {}),
            startsOn: f.startsOn,
            endsOn: f.endsOn,
            ...(f.annualValue ? { annualValue: f.annualValue } : {}),
            noticeDays: Number(f.noticeDays),
          },
        }),
      ),
    {
      invalidate: [keys.contractsAll],
      onDone: (c) => {
        toast.show(`${c.code} is recorded.`);
        router.push(`/contracts/${c.id}`);
      },
    },
  );
  const ready = f.code.trim() && f.vendorName.trim() && f.startsOn && f.endsOn;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New contract"
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="Reference" hint="Unique, e.g. AMC-LIFTS-2026." error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} value={f.code} onChange={set('code')} />}
          </Field>
          <Field label="Kind" error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Vendor" error={fieldError(save.error, 'vendorName')}>
            {(p) => <Input {...p} value={f.vendorName} onChange={set('vendorName')} />}
          </Field>
          <Field label="Vendor’s phone" error={fieldError(save.error, 'vendorPhone')}>
            {(p) => <Input {...p} value={f.vendorPhone} onChange={set('vendorPhone')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Starts on" error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label="Ends on" hint="Its last day." error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Yearly value (EGP)" error={fieldError(save.error, 'annualValue')}>
            {(p) => <Input {...p} value={f.annualValue} onChange={set('annualValue')} />}
          </Field>
          <Field label="Notice days" hint="How long before its end we are told." error={fieldError(save.error, 'noticeDays')}>
            {(p) => <Input {...p} type="number" min={0} max={180} value={f.noticeDays} onChange={set('noticeDays')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** The compound's maintenance contracts (ADR 0065), by end date. */
export default function ContractsPage() {
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('active');
  const [creating, setCreating] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.contracts(filters), (c) => fetchers.contracts(filters, c), { enabled: can('assets.manage') });
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title="Contracts" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Contracts"
        description="Maintenance contracts with vendors: what they cover and until when."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New contract
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'ended', label: 'Ended' },
            { value: 'terminated', label: 'Terminated' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<MaintenanceContract>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty="No contract"
            columns={[
              {
                key: 'c',
                header: 'Reference',
                cell: (c) => (
                  <Link className="table__link" href={`/contracts/${c.id}`}>
                    {c.code}
                  </Link>
                ),
              },
              { key: 'k', header: 'Kind', cell: (c) => humanize(c.kind) },
              { key: 'v', header: 'Vendor', cell: (c) => c.vendorName },
              { key: 'e', header: 'Ends', cell: (c) => formatDate(c.endsOn) },
              { key: 'a', header: 'Assets', cell: (c) => c.assetIds.length },
              { key: 'y', header: 'A year', cell: (c) => (c.annualValue ? `${c.annualValue} EGP` : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewContractDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
