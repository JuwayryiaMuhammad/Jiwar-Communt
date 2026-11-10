'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  Stat,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceItem } from '@/lib/queries';
import ar from '@/messages/ar/compliance-list';
import en from '@/messages/en/compliance-list';

/** What the compound keeps valid (ADR 0087). */
const COMPLIANCE_KINDS = ['fire_system', 'lift', 'insurance', 'licence', 'permit', 'other'] as const;
type Kind = (typeof COMPLIANCE_KINDS)[number] | '';

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        toast.show(t('added'));
        router.push(`/compliance/${item.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newTitle')}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.title.trim() || !f.firstDueOn}>
            {t('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={c('kind')} error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {COMPLIANCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('firstDue')} error={fieldError(save.error, 'firstDueOn')}>
            {(p) => <Input {...p} type="date" value={f.firstDueOn} onChange={set('firstDueOn')} />}
          </Field>
        </div>
        <Field label={t('titleField')} error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <div className="form__row">
          <Field label={t('authority')} hint={t('authorityHint')} error={fieldError(save.error, 'authority')}>
            {(p) => <Input {...p} value={f.authority} onChange={set('authority')} />}
          </Field>
          <Field label={t('reference')} error={fieldError(save.error, 'reference')}>
            {(p) => <Input {...p} value={f.reference} onChange={set('reference')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('staffMember')} hint={t('staffHint')} error={fieldError(save.error, 'ownerId')}>
            {(p) => (
              <Select {...p} value={f.ownerId} onChange={set('ownerId')}>
                <option value="">{t('nobody')}</option>
                {owners.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('vendor')} error={fieldError(save.error, 'vendorId')}>
            {(p) => (
              <Select {...p} value={f.vendorId} onChange={set('vendorId')}>
                <option value="">{t('noVendor')}</option>
                {(vendors.data?.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.reference} · {v.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('everyMonths')} hint={t('everyHint')} error={fieldError(save.error, 'recurrenceMonths')}>
          {(p) => <Input {...p} inputMode="numeric" className="ltr" value={f.recurrenceMonths} onChange={set('recurrenceMonths')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The compliance calendar's items and where they stand (ADR 0087). */
export default function CompliancePage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('compliance.manage');
  const [kind, setKind] = useState<Kind>('');
  const [creating, setCreating] = useState(false);
  const [csvError, setCsvError] = useState<unknown>(null);
  const filters = { kind, status: 'active' as const };
  const list = useCursorList(keys.complianceItems(filters), (cursor) => fetchers.complianceItems(filters, cursor), { enabled: allowed });
  const report = useQuery({ queryKey: keys.complianceReport, queryFn: fetchers.complianceReport, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const totals = report.data?.totals;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button onClick={() => download('/api/v1/staff/compliance/report/export', {}, 'compliance-status.csv').catch(setCsvError)}>
              {t('exportCsv')}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('newItem')}
            </Button>
          </>
        }
      />
      <ErrorAlert error={csvError} />
      {totals && report.data ? (
        <div className="grid grid--stats">
          <Stat label={t('stat.valid')} value={fmt.number(totals.valid)} />
          <Stat label={t('stat.dueSoon')} value={fmt.number(totals.dueSoon)} />
          <Stat label={t('stat.overdue')} value={fmt.number(totals.overdue)} />
          <Stat label={t('stat.completed')} value={fmt.number(totals.completed)} />
          <Stat label={t('stat.vendorPapers')} value={fmt.number(report.data.vendorPapers.expired)} />
        </div>
      ) : null}
      <div className="toolbar">
        <Segmented<Kind>
          label={c('kind')}
          value={kind}
          onChange={setKind}
          options={[{ value: '', label: c('all') }, ...COMPLIANCE_KINDS.map((k) => ({ value: k, label: label(k) }))]}
        />
      </div>
      <Card flush>
        <CardHeader title={t('itemsTitle')} />
        <QueryState query={list}>
          <DataTable<ComplianceItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('none')}
            columns={[
              {
                key: 't',
                header: t('col.item'),
                cell: (i) => (
                  <Link className="table__link" href={`/compliance/${i.id}`}>
                    {i.title}
                  </Link>
                ),
              },
              { key: 'k', header: c('kind'), cell: (i) => label(i.kind) },
              { key: 's', header: t('col.state'), cell: (i) => label(i.state) },
              { key: 'd', header: t('col.due'), cell: (i) => (i.current ? fmt.day(i.current.dueOn) : '—') },
              { key: 'v', header: t('col.answers'), cell: (i) => [i.vendor?.name, i.owner?.fullName].filter(Boolean).join(' · ') || '—' },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewItemDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
