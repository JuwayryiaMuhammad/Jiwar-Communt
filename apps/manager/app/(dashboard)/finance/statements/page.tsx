'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, Dialog, Field, ForbiddenState, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Import = Schema<'StatementImportView'>;
type Line = Schema<'StatementLineView'>;
const KEY = ['finance', 'statements'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

/** A line matched by hand: one of its candidates, or an adjustment. */
function Match({ line, onClose }: { line: Line; onClose: () => void }) {
  const toast = useToast();
  const candidates = useQuery({
    queryKey: [...KEY, 'candidates', line.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/statement-lines/{id}/candidates', { params: { path: { id: line.id } } })),
  });
  const [choice, setChoice] = useState('');
  const [code, setCode] = useState('');
  const picked = candidates.data?.data.find((c) => `${c.kind}:${c.id}` === choice);
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
        toast.show('Matched.');
        onClose();
      },
    },
  );
  const ok = picked || (choice === 'adjustment' && code);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Match ${line.amount} EGP on ${line.bookedOn}`}
      description={line.reference ?? undefined}
      onSubmit={() => ok && match.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={match.isPending} disabled={!ok}>
            Match
          </Button>
        </>
      }
    >
      <QueryState query={candidates}>
        <div className="form">
          <Field label="To" hint="The same amount within 30 days, or an adjustment (a bank charge, an interest).">
            {(p) => (
              <Select {...p} value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose…</option>
                {candidates.data?.data.map((c) => (
                  <option key={c.id} value={`${c.kind}:${c.id}`}>
                    {label(c.kind)} · {c.amount} EGP · {c.onDay}
                    {c.reference ? ` · ${c.reference}` : ''}
                    {c.unitCode ? ` · ${c.unitCode}` : ''}
                  </option>
                ))}
                <option value="adjustment">An adjustment…</option>
              </Select>
            )}
          </Field>
          {choice === 'adjustment' ? (
            <Field label="Why" error={fieldError(match.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
                  <option value="">Choose…</option>
                  {REASON_CODES.cashAdjust.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
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
      toast.show(`${r.importedCount} line(s) imported, ${r.matchedCount} matched on their own.`);
      setChecked(null);
    },
  });
  const undo = useAction((l: Line) => unwrap(api.POST('/api/v1/staff/finance/statement-matches/{id}/undo', { params: { path: { id: l.match!.id } } })), {
    invalidate: [KEY, ['finance', 'cash-accounts']],
    onDone: () => toast.show('Undone.'),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Bank statements" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Bank statements" description="Import a bank's CSV and match its lines to the payments, cheques and transfers recorded here." />
      <div className="stack">
        <Card>
          <CardHeader title="Import" />
          <CardBody>
            <div className="form">
              <Field label="Bank account">
                {(p) => (
                  <Select {...p} value={accountId} onChange={(e) => {
                      setAccountId(e.target.value);
                      setChecked(null);
                    }}>
                    <option value="">Choose…</option>
                    {banks.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="t-muted">Columns: date (YYYY-MM-DD), amount (money in positive), reference, description. The same file twice imports nothing new.</p>
              <FileUpload purpose="data_import" label="Check a statement" disabled={!accountId || check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
              <ErrorAlert error={check.error} />
              {checked ? (
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <Badge tone={checked.status === 'valid' ? 'green' : 'error'}>{label(checked.status)}</Badge>
                    <span>
                      {checked.rowCount} line(s): {checked.newCount} new, {checked.duplicateCount} imported before, {checked.errorCount} wrong
                    </span>
                  </span>
                  {checked.errors.length ? (
                    <ul>
                      {checked.errors.map((e) => (
                        <li key={`${e.line}-${e.field}`}>
                          Line {e.line}, {e.field}: {label(e.code.toLowerCase())}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {checked.status === 'valid' ? (
                    <div>
                      <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate(undefined)}>
                        Apply
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
              label="Lines"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'unmatched', label: 'Waiting' },
                { value: 'matched', label: 'Matched' },
              ]}
            />
            <ErrorAlert error={undo.error} />
            <Card flush>
              <QueryState query={lines}>
                <DataTable<Line>
                  rows={lines.data?.data}
                  rowKey={(l) => l.id}
                  empty="None"
                  columns={[
                    { key: 'd', header: 'Day', cell: (l) => l.bookedOn },
                    { key: 'a', header: 'Amount', cell: (l) => <span className="t-mono">{l.amount}</span> },
                    { key: 'r', header: 'Reference', cell: (l) => l.reference ?? '—' },
                    { key: 't', header: 'Description', cell: (l) => l.description ?? '—' },
                    {
                      key: 'm',
                      header: 'Match',
                      cell: (l) => (l.match ? <Badge tone="green">{`${label(l.match.kind)}${l.match.auto ? ' · on its own' : ''}`}</Badge> : '—'),
                    },
                    {
                      key: 'x',
                      header: '',
                      className: 'table__actions',
                      cell: (l) =>
                        l.match ? (
                          <Button size="sm" onClick={() => undo.mutate(l)}>
                            Undo
                          </Button>
                        ) : (
                          <Button size="sm" variant="primary" onClick={() => setMatching(l)}>
                            Match
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
