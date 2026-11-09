'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { reconciliationLabel } from '@/components/finance/gl';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Account = Schema<'GlAccountView'>;
type Check = Schema<'GlReconciliationCheckView'>;

const money = (v: string) => <span className="t-mono">{v}</span>;

function AddDialog({ parent, onClose }: { parent: Account; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(`${parent.code}.`);
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const add = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/gl/accounts', { body: { parentId: parent.id, code, nameEn, nameAr } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show('Sub-account added.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`A sub-account of ${parent.code} ${parent.nameEn}`}
      description="Of its parent’s type. Its code is its parent’s, a dot, and up to three digits."
      onSubmit={() => add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Code" error={fieldError(add.error, 'code')}>
          {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label="Name (English)" error={fieldError(add.error, 'nameEn')}>
          {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(add.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

function RenameDialog({ account, onClose }: { account: Account; onClose: () => void }) {
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
        toast.show('Account renamed.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rename ${account.code}`}
      description="Its names only: a code, a type and a place never change."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
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
        toast.show('Sub-account removed.');
        setRemoving(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Chart of accounts" />
        <ForbiddenState />
      </>
    );
  const depth = (a: Account) => a.code.split('.').length - 1 + (a.parentId && !a.code.includes('.') ? 1 : 0);
  const r = recon.data;
  const checks: Check[] = r ? [...r.checks, ...r.cashAccounts.map((c) => ({ ...c, key: c.name }))] : [];
  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="The general ledger in double entry: every money event posts its entry when it happens. The computed journal stays under Ledger."
        actions={
          <Field label="As of">{(p) => <Input {...p} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
        }
      />
      <div className="stack">
        <QueryState query={recon} rows={2}>
          {r ? (
            <Card flush>
              <SectionHeader
                title="Against the registers"
                description={r.balanced ? 'Every debit has its credit.' : 'The debits and the credits differ: tell support.'}
              />
              <DataTable<Check>
                rows={checks}
                rowKey={(c) => c.key}
                columns={[
                  { key: 'k', header: 'What', cell: (c) => reconciliationLabel(c.key) },
                  { key: 'r', header: 'Register', cell: (c) => money(c.register) },
                  { key: 'l', header: 'Ledger', cell: (c) => money(c.ledger) },
                  {
                    key: 'd',
                    header: 'Difference',
                    cell: (c) => (c.difference === '0.00' ? <Badge tone="green">Agrees</Badge> : <Badge tone="terracotta">{c.difference}</Badge>),
                  },
                ]}
              />
            </Card>
          ) : null}
        </QueryState>
        <QueryState query={chart} rows={8}>
          {chart.data ? (
            <Card flush>
              <SectionHeader title={`The chart on ${chart.data.asOf}`} description="Balances on each account’s normal side, with its sub-accounts’." />
              <DataTable<Account>
                rows={chart.data.accounts}
                rowKey={(a) => a.id}
                columns={[
                  {
                    key: 'c',
                    header: 'Code',
                    cell: (a) => <span style={{ paddingInlineStart: depth(a) * 12 }}>{a.code}</span>,
                  },
                  {
                    key: 'n',
                    header: 'Account',
                    cell: (a) =>
                      a.postable ? (
                        <Link href={`/finance/gl/accounts/${a.id}`}>{a.nameEn}</Link>
                      ) : (
                        <strong>{a.nameEn}</strong>
                      ),
                  },
                  { key: 't', header: 'Type', cell: (a) => a.type },
                  {
                    key: 'k',
                    header: '',
                    cell: (a) => (a.control ? <Badge tone="beige">Kept by its register</Badge> : a.system ? null : <Badge>Yours</Badge>),
                  },
                  { key: 'b', header: 'Balance', cell: (a) => money(a.balance) },
                  {
                    key: 'a',
                    header: '',
                    cell: (a) =>
                      write ? (
                        <span className="row" style={{ gap: 6 }}>
                          {a.control ? null : (
                            <Button size="sm" onClick={() => setAdding(a)}>
                              Sub-account
                            </Button>
                          )}
                          <Button size="sm" onClick={() => setRenaming(a)}>
                            Rename
                          </Button>
                          {a.system ? null : (
                            <Button size="sm" variant="danger" onClick={() => setRemoving(a)}>
                              Remove
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
        title={`Remove ${removing?.code ?? ''}?`}
        description="Only a sub-account nothing posted to and nothing hangs under."
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </>
  );
}
