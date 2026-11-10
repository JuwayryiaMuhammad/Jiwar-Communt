'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceContract } from '@/lib/queries';
import ar from '@/messages/ar/contracts';
import en from '@/messages/en/contracts';

const KINDS = ['amc', 'service', 'warranty_extension', 'cleaning', 'security', 'landscaping', 'pest_control', 'supply', 'other'] as const;
type Status = MaintenanceContract['status'] | '';

function NewContractDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
      onDone: (x) => {
        toast.show(t('recorded', { code: x.code }));
        router.push(`/contracts/${x.id}`);
      },
    },
  );
  const ready = f.code.trim() && f.vendorName.trim() && f.startsOn && f.endsOn;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newContract')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={t('reference')} hint={t('referenceHint')} error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} className="ltr" value={f.code} onChange={set('code')} />}
          </Field>
          <Field label={c('kind')} error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('vendor')} error={fieldError(save.error, 'vendorName')}>
            {(p) => <Input {...p} value={f.vendorName} onChange={set('vendorName')} />}
          </Field>
          <Field label={t('vendorPhone')} error={fieldError(save.error, 'vendorPhone')}>
            {(p) => <Input {...p} className="ltr" value={f.vendorPhone} onChange={set('vendorPhone')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('startsOn')} error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label={t('endsOn')} hint={t('endsOnHint')} error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('yearlyValue')} error={fieldError(save.error, 'annualValue')}>
            {(p) => <Input {...p} value={f.annualValue} onChange={set('annualValue')} />}
          </Field>
          <Field label={t('noticeDays')} hint={t('noticeDaysHint')} error={fieldError(save.error, 'noticeDays')}>
            {(p) => <Input {...p} type="number" min={0} max={180} value={f.noticeDays} onChange={set('noticeDays')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** The compound's maintenance contracts (ADR 0065), by end date. */
export default function ContractsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('active');
  const [creating, setCreating] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.contracts(filters), (c) => fetchers.contracts(filters, c), { enabled: can('assets.manage') });
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('newContract')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: label('active') },
            { value: 'upcoming', label: label('upcoming') },
            { value: 'ended', label: label('ended') },
            { value: 'terminated', label: label('terminated') },
            { value: '', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<MaintenanceContract>
            rows={list.rows}
            rowKey={(x) => x.id}
            empty={t('empty')}
            columns={[
              {
                key: 'c',
                header: t('reference'),
                cell: (x) => (
                  <Link className="table__link" href={`/contracts/${x.id}`}>
                    {x.code}
                  </Link>
                ),
              },
              { key: 'k', header: c('kind'), cell: (x) => label(x.kind) },
              { key: 'v', header: t('vendor'), cell: (x) => x.vendorName },
              { key: 'e', header: t('ends'), cell: (x) => f.day(x.endsOn) },
              { key: 'a', header: t('assets'), cell: (x) => f.number(x.assetIds.length) },
              { key: 'y', header: t('aYear'), cell: (x) => (x.annualValue ? f.money(x.annualValue) : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewContractDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
