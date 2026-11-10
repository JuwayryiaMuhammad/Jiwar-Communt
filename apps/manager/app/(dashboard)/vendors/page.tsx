'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorSummary } from '@/lib/queries';
import ar from '@/messages/ar/ops-vendors';
import en from '@/messages/en/ops-vendors';

type Status = VendorSummary['status'] | '';
const VIEWS = ['active', 'suspended', ''] as const;

function NewVendorDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ name: '', phone: '', email: '', taxNumber: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/vendors', {
          body: {
            name: f.name.trim(),
            ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
            ...(f.email.trim() ? { email: f.email.trim() } : {}),
            ...(f.taxNumber.trim() ? { taxNumber: f.taxNumber.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.vendorsAll],
      onDone: (v) => {
        toast.show(t('registered', { name: v.name, reference: v.reference }));
        router.push(`/vendors/${v.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newVendor')}
      onSubmit={() => f.name.trim() && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.name.trim()}>
            {t('register')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label={t('name')} hint={t('nameHint')} error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} value={f.name} onChange={set('name')} />}
        </Field>
        <div className="form__row">
          <Field label={t('phone')} error={fieldError(save.error, 'phone')}>
            {(p) => <Input {...p} dir="ltr" value={f.phone} onChange={set('phone')} />}
          </Field>
          <Field label={t('email')} error={fieldError(save.error, 'email')}>
            {(p) => <Input {...p} dir="ltr" value={f.email} onChange={set('email')} />}
          </Field>
        </div>
        <Field label={t('taxNumber')} error={fieldError(save.error, 'taxNumber')}>
          {(p) => <Input {...p} value={f.taxNumber} onChange={set('taxNumber')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The compound's vendor register (ADR 0077). */
export default function VendorsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('active');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const filters = { status, ...(q.trim() ? { q: q.trim() } : {}) };
  const list = useCursorList(keys.vendors(filters), (c) => fetchers.vendors(filters, c), { enabled: can('vendors.manage') });
  if (ready && !can('vendors.manage'))
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
            {t('newVendor')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
        <Input aria-label={t('search')} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<VendorSummary>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty={t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.vendor'),
                cell: (v) => (
                  <Link className="table__link" href={`/vendors/${v.id}`}>
                    <bdi>{v.reference}</bdi> · {v.name}
                  </Link>
                ),
              },
              { key: 'c', header: t('col.trades'), cell: (v) => fmt.list(v.categories.map(label)) },
              { key: 's', header: t('col.status'), cell: (v) => label(v.status) },
              { key: 'p', header: t('col.phone'), cell: (v) => (v.phone ? <bdi>{v.phone}</bdi> : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewVendorDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
