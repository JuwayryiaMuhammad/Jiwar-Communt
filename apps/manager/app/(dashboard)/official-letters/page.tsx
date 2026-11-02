'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

interface Letter {
  id: string;
  number: string;
  kind: string;
  unitCode: string;
  subjectName: string | null;
  issuedAt: string;
  status: 'valid' | 'revoked';
}

const KINDS = ['residence_confirmation', 'no_objection', 'to_whom_it_may_concern'] as const;
const KEY = ['official-letters'];

/**
 * Official letters (ADR 0080): issued for a unit's owner or tenant, drawn as
 * a PDF with a code anyone checks on the public page, revoked once.
 */
export default function OfficialLettersPage() {
  const { can } = usePermissions();
  const toast = useToast();
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<Letter | null>(null);
  const [form, setForm] = useState({ kind: 'residence_confirmation', unitId: '', accountId: '', addressee: '', subject: '' });
  const letters = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/official-letters', { params: { query: { limit: 100 } } })) as Promise<{ data: Letter[] }>,
    enabled: can('letters.issue'),
  });
  const issue = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/official-letters', {
          body: {
            kind: form.kind as (typeof KINDS)[number],
            unitId: form.unitId.trim(),
            accountId: form.accountId.trim(),
            ...(form.addressee.trim() ? { addressee: form.addressee.trim() } : {}),
            ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
          },
        }),
      ) as Promise<Letter>,
    {
      invalidate: [KEY],
      onDone: (l: Letter) => {
        toast.show(`${l.number} is issued. Its subject was told.`);
        setIssuing(false);
      },
    },
  );
  const revoke = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/official-letters/{id}/revoke', { params: { path: { id: revoking!.id } }, body: { reasonCode } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(`${revoking?.number} is revoked. Its check now says so.`);
        setRevoking(null);
      },
    },
  );
  if (!can('letters.issue')) return <ForbiddenState />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageHeader
        title="Official letters"
        description="Residence confirmations, no-objection letters and letters to whom it may concern. Each prints a code anyone can check on the public page; the check tells only whether it stands, who issued it and when."
        actions={
          <Button variant="primary" onClick={() => setIssuing(true)}>
            Issue a letter
          </Button>
        }
      />
      <Card flush>
        <QueryState query={letters}>
          <DataTable
            rows={letters.data?.data ?? []}
            rowKey={(l) => l.id}
            columns={[
              { key: 'number', header: 'Number', cell: (l) => l.number },
              { key: 'kind', header: 'Kind', cell: (l) => humanize(l.kind) },
              { key: 'unit', header: 'Unit', cell: (l) => l.unitCode },
              { key: 'for', header: 'For', cell: (l) => l.subjectName ?? <span className="t-secondary">Erased</span> },
              { key: 'issued', header: 'Issued', cell: (l) => formatDateTime(l.issuedAt) },
              { key: 'status', header: 'Status', cell: (l) => <StatusBadge status={l.status} /> },
              {
                key: 'actions',
                header: '',
                cell: (l) => (
                  <span className="row">
                    {l.subjectName ? (
                      <a className="table__link" href={`/api/v1/staff/official-letters/${l.id}/pdf`}>
                        PDF
                      </a>
                    ) : null}
                    {l.status === 'valid' ? <Button onClick={() => setRevoking(l)}>Revoke</Button> : null}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>

      <Dialog
        open={issuing}
        onClose={() => setIssuing(false)}
        title="Issue a letter"
        description="For an owner or a tenant holding a place in the unit now. Its words come from its kind; the name, the capacity and since when are printed as they are today."
        onSubmit={() => form.unitId && form.accountId && issue.mutate()}
        footer={
          <>
            <Button onClick={() => setIssuing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={issue.isPending} disabled={!form.unitId || !form.accountId || (form.kind === 'no_objection' && !form.subject.trim())}>
              Issue
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Kind">
            {(p) => (
              <Select {...p} value={form.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Unit id">{(p) => <Input {...p} value={form.unitId} onChange={set('unitId')} />}</Field>
          <Field label="Resident account id">{(p) => <Input {...p} value={form.accountId} onChange={set('accountId')} />}</Field>
          <Field label="To" hint="Optional: whom the letter is addressed to.">
            {(p) => <Input {...p} maxLength={150} value={form.addressee} onChange={set('addressee')} />}
          </Field>
          <Field label="About" hint={form.kind === 'no_objection' ? 'Required: what there is no objection to.' : 'Optional.'}>
            {(p) => <Input {...p} maxLength={300} value={form.subject} onChange={set('subject')} />}
          </Field>
          <ErrorAlert error={issue.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.number}?`}
        description="Once only. Its public check says it no longer stands."
        codes={REASON_CODES.officialLetterRevoke}
        confirmLabel="Revoke"
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(code) => revoke.mutate(code)}
      />
    </>
  );
}
