'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-statements';
import en from '@/messages/en/fin-statements';

type Import = Schema<'StatementImportView'>;
type Line = Schema<'StatementLineView'>;
const KEY = ['finance', 'statements'] as const;

/** A line matched by hand: one of its candidates, or an adjustment. */
function Match({ line, onClose }: { line: Line; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const candidates = useQuery({
    queryKey: [...KEY, 'candidates', line.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/statement-lines/{id}/candidates', { params: { path: { id: line.id } } })),
  });
  const [choice, setChoice] = useState('');
  const [code, setCode] = useState('');
  const picked = candidates.data?.data.find((x) => `${x.kind}:${x.id}` === choice);
  const match = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/statement-lines/{id}/match', {
          params: { path: { id: line.id } },
          body: picked ? { kind: picked.kind as 'payment' | 'cheque' | 'transfer', targetId: picked.id } : { kind: 'adjustment', reasonCode: code },
        }),
      ),
    {
      invalidate: [KEY, ['finance', 'cash-accounts']],
      onDone: () => {
        toast.show(t('match.done'));
        onClose();
      },
    },
  );
  const ok = picked || (choice === 'adjustment' && code);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('match.title', { amount: f.money(line.amount), day: f.day(line.bookedOn) })}
      description={line.reference ?? undefined}
      onSubmit={() => ok && match.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={match.isPending} disabled={!ok}>
            {t('match')}
          </Button>
        </>
      }
    >
      <QueryState query={candidates}>
        <div className="form">
          <Field label={t('match.to')} hint={t('match.hint')}>
            {(p) => (
              <Select {...p} value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">{t('match.choose')}</option>
                {candidates.data?.data.map((x) => (
                  <option key={x.id} value={`${x.kind}:${x.id}`}>
                    {label(x.kind)} · {f.money(x.amount)} · {f.day(x.onDay)}
                    {x.reference ? ` · ${x.reference}` : ''}
                    {x.unitCode ? ` · ${x.unitCode}` : ''}
                  </option>
                ))}
                <option value="adjustment">{t('match.adjustment')}</option>
              </Select>
            )}
          </Field>
          {choice === 'adjustment' ? (
            <Field label={t('match.why')} error={fieldError(match.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
                  <option value="">{t('match.choose')}</option>
                  {REASON_CODES.cashAdjust.map((x) => (
                    <option key={x} value={x}>
                      {label(x)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <ErrorAlert error={match.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

/**
 * Bank statements (ADR 0085): a CSV checked first — what is new, what was
 * imported before, what is wrong — then applied once; lines that name
 * exactly one payment, cheque or transfer match on their own, the rest
 * wait here.
 */
export default function StatementsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.treasury');
  const toast = useToast();
  const accounts = useQuery({ queryKey: ['finance', 'cash-accounts'], queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-accounts')), enabled: allowed });
  const banks = (accounts.data?.data ?? []).filter((a) => a.kind === 'bank');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState<'unmatched' | 'matched'>('unmatched');
  const [checked, setChecked] = useState<Import | null>(null);
  const [matching, setMatching] = useState<Line | null>(null);
  const lines = useQuery({
    queryKey: [...KEY, 'lines', accountId, status],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/statement-lines', { params: { query: { accountId, status, limit: 100 } } })),
    enabled: allowed && !!accountId,
  });
  const check = useAction(
    (fileId: string) => unwrap(api.POST('/api/v1/staff/finance/cash-accounts/{id}/statement-imports', { params: { path: { id: accountId } }, body: { fileId } })),
    { onDone: (r) => setChecked(r) },
  );
  const apply = useAction(() => unwrap(api.POST('/api/v1/staff/finance/statement-imports/{id}/apply', { params: { path: { id: checked!.id } } })), {
    invalidate: [KEY, ['finance', 'cash-accounts']],
    onDone: (r) => {
      toast.show(t('applied', { imported: r.importedCount, matched: f.number(r.matchedCount) }));
      setChecked(null);
    },
  });
  const undo = useAction((l: Line) => unwrap(api.POST('/api/v1/staff/finance/statement-matches/{id}/undo', { params: { path: { id: l.match!.id } } })), {
    invalidate: [KEY, ['finance', 'cash-accounts']],
    onDone: () => toast.show(t('undone')),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Card>
          <CardHeader title={t('importTitle')} />
          <CardBody>
            <div className="form">
              <Field label={t('bankAccount')}>
                {(p) => (
                  <Select
                    {...p}
                    value={accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value);
                      setChecked(null);
                    }}
                  >
                    <option value="">{t('match.choose')}</option>
                    {banks.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="t-muted">{t('columns')}</p>
              <FileUpload purpose="data_import" label={t('check')} disabled={!accountId || check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
              <ErrorAlert error={check.error} />
              {checked ? (
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <Badge tone={checked.status === 'valid' ? 'green' : 'error'}>{label(checked.status)}</Badge>
                    <span>
                      {t('summary', {
                        rows: checked.rowCount,
                        fresh: f.number(checked.newCount),
                        duplicates: f.number(checked.duplicateCount),
                        errors: f.number(checked.errorCount),
                      })}
                    </span>
                  </span>
                  {checked.errors.length ? (
                    <ul>
                      {checked.errors.map((e) => (
                        <li key={`${e.line}-${e.field}`}>
                          {t('errorLine', { line: f.number(e.line), field: e.field, what: label(e.code.toLowerCase()) })}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {checked.status === 'valid' ? (
                    <div>
                      <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate(undefined)}>
                        {t('apply')}
                      </Button>
                    </div>
                  ) : null}
                  <ErrorAlert error={apply.error} />
                </div>
              ) : null}
            </div>
          </CardBody>
        </Card>
        {accountId ? (
          <>
            <Segmented
              label={t('lines')}
              value={status}
              onChange={setStatus}
              options={[
                { value: 'unmatched', label: t('waiting') },
                { value: 'matched', label: t('matched') },
              ]}
            />
            <ErrorAlert error={undo.error} />
            <Card flush>
              <QueryState query={lines}>
                <DataTable<Line>
                  rows={lines.data?.data}
                  rowKey={(l) => l.id}
                  empty={t('empty')}
                  columns={[
                    { key: 'd', header: t('day'), cell: (l) => f.day(l.bookedOn) },
                    { key: 'a', header: c('amount'), cell: (l) => <span className="t-mono">{f.number(l.amount, { minimumFractionDigits: 2 })}</span> },
                    { key: 'r', header: t('reference'), cell: (l) => l.reference ?? '—' },
                    { key: 't', header: t('description2'), cell: (l) => l.description ?? '—' },
                    {
                      key: 'm',
                      header: t('match'),
                      cell: (l) => (l.match ? <Badge tone="green">{l.match.auto ? t('onItsOwn', { kind: label(l.match.kind) }) : label(l.match.kind)}</Badge> : '—'),
                    },
                    {
                      key: 'x',
                      header: '',
                      className: 'table__actions',
                      cell: (l) =>
                        l.match ? (
                          <Button size="sm" onClick={() => undo.mutate(l)}>
                            {t('undo')}
                          </Button>
                        ) : (
                          <Button size="sm" variant="primary" onClick={() => setMatching(l)}>
                            {t('match')}
                          </Button>
                        ),
                    },
                  ]}
                />
              </QueryState>
            </Card>
          </>
        ) : null}
      </div>
      {matching ? <Match line={matching} onClose={() => setMatching(null)} /> : null}
    </>
  );
}
