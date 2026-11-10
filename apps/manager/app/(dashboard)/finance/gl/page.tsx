'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Format } from '@jiwar/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/money-gl';
import en from '@/messages/en/money-gl';

type Account = Schema<'GlAccountView'>;
type Check = Schema<'GlReconciliationCheckView'>;

const money = (fmt: Format, v: string) => <span className="t-mono">{fmt.number(v, { minimumFractionDigits: 2 })}</span>;

/** What a reconciliation line checks; a bank or cash account's line is keyed by its name. */
const RECON = ['receivables', 'unit_credit', 'deposits_held', 'payables', 'retentions', 'vendor_advances', 'cash_account'] as const;
const isRecon = (k: string): k is (typeof RECON)[number] => (RECON as readonly string[]).includes(k);

/** An account's name in the page's language. */
function useAccountName() {
  const { locale } = useLocale();
  return (a: { nameEn: string; nameAr: string }) => (locale === 'ar' ? a.nameAr : a.nameEn);
}

function AddDialog({ parent, onClose }: { parent: Account; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const name = useAccountName();
  const toast = useToast();
  const [code, setCode] = useState(`${parent.code}.`);
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const add = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/gl/accounts', { body: { parentId: parent.id, code, nameEn, nameAr } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('added'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('addTitle', { code: parent.code, name: name(parent) })}
      description={t('addDescription')}
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('code')} error={fieldError(add.error, 'code')}>
          {(p) => <Input {...p} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label={t('nameEn')} error={fieldError(add.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(add.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

function RenameDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [nameEn, setNameEn] = useState(account.nameEn);
  const [nameAr, setNameAr] = useState(account.nameAr);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/finance/gl/accounts/{id}', {
          params: { path: { id: account.id } },
          body: { nameEn, nameAr },
        }),
      ),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('renamed'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('renameTitle', { code: account.code })}
      description={t('renameDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * The chart of accounts (ADR 0092): every account with its balance on a
 * day, the standard chart seeded for the compound and each bank and cash
 * account's own; sub-accounts added, renamed and removed while unused; and
 * the ledger against the registers it posts from.
 */
export default function ChartOfAccountsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const name = useAccountName();
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const write = can('finance.ledger_write');
  const [asOf, setAsOf] = useState('');
  const [adding, setAdding] = useState<Account | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const toast = useToast();
  const chart = useQuery({ queryKey: keys.glChart(asOf), queryFn: () => fetchers.glChart(asOf), enabled: allowed });
  const recon = useQuery({ queryKey: keys.glReconciliation, queryFn: fetchers.glReconciliation, enabled: allowed });
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/staff/finance/gl/accounts/{id}', { params: { path: { id } } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('removed'));
        setRemoving(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const depth = (a: Account) => a.code.split('.').length - 1 + (a.parentId && !a.code.includes('.') ? 1 : 0);
  const r = recon.data;
  const checks: Check[] = r ? [...r.checks, ...r.cashAccounts.map((x) => ({ ...x, key: x.name }))] : [];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Field label={t('asOf')}>{(p) => <Input {...p} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
        }
      />
      <div className="stack">
        <QueryState query={recon} rows={2}>
          {r ? (
            <Card flush>
              <SectionHeader title={t('reconTitle')} description={r.balanced ? t('balanced') : t('unbalanced')} />
              <DataTable<Check>
                rows={checks}
                rowKey={(x) => x.key}
                columns={[
                  { key: 'k', header: t('col.what'), cell: (x) => (isRecon(x.key) ? t(`recon.${x.key}`) : x.key) },
                  { key: 'r', header: t('col.register'), cell: (x) => money(fmt, x.register) },
                  { key: 'l', header: t('col.ledger'), cell: (x) => money(fmt, x.ledger) },
                  {
                    key: 'd',
                    header: t('col.difference'),
                    cell: (x) =>
                      x.difference === '0.00' ? (
                        <Badge tone="green">{t('agrees')}</Badge>
                      ) : (
                        <Badge tone="terracotta">{fmt.number(x.difference, { minimumFractionDigits: 2 })}</Badge>
                      ),
                  },
                ]}
              />
            </Card>
          ) : null}
        </QueryState>
        <QueryState query={chart} rows={8}>
          {chart.data ? (
            <Card flush>
              <SectionHeader title={t('chartOn', { day: fmt.day(chart.data.asOf) })} description={t('chartDescription')} />
              <DataTable<Account>
                rows={chart.data.accounts}
                rowKey={(a) => a.id}
                columns={[
                  {
                    key: 'c',
                    header: t('col.code'),
                    cell: (a) => <span style={{ paddingInlineStart: depth(a) * 12 }}>{a.code}</span>,
                  },
                  {
                    key: 'n',
                    header: t('col.account'),
                    cell: (a) => (a.postable ? <Link href={`/finance/gl/accounts/${a.id}`}>{name(a)}</Link> : <strong>{name(a)}</strong>),
                  },
                  { key: 't', header: t('col.type'), cell: (a) => label(a.type) },
                  {
                    key: 'k',
                    header: '',
                    cell: (a) => (a.control ? <Badge tone="beige">{t('control')}</Badge> : a.system ? null : <Badge>{t('yours')}</Badge>),
                  },
                  { key: 'b', header: t('col.balance'), cell: (a) => money(fmt, a.balance) },
                  {
                    key: 'a',
                    header: '',
                    cell: (a) =>
                      write ? (
                        <span className="row" style={{ gap: 6 }}>
                          {a.control ? null : (
                            <Button size="sm" onClick={() => setAdding(a)}>
                              {t('subAccount')}
                            </Button>
                          )}
                          <Button size="sm" onClick={() => setRenaming(a)}>
                            {t('rename')}
                          </Button>
                          {a.system ? null : (
                            <Button size="sm" variant="danger" onClick={() => setRemoving(a)}>
                              {c('remove')}
                            </Button>
                          )}
                        </span>
                      ) : null,
                  },
                ]}
              />
            </Card>
          ) : null}
        </QueryState>
      </div>
      {adding ? <AddDialog parent={adding} onClose={() => setAdding(null)} /> : null}
      {renaming ? <RenameDialog account={renaming} onClose={() => setRenaming(null)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('removeTitle', { code: removing?.code ?? '' })}
        description={t('removeDescription')}
        confirmLabel={c('remove')}
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </>
  );
}
