'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/services-official-letters';
import en from '@/messages/en/services-official-letters';

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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(t('issuedToast', { number: l.number }));
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
        toast.show(t('revokedToast', { number: revoking?.number }));
        setRevoking(null);
      },
    },
  );
  if (!can('letters.issue')) return <ForbiddenState />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setIssuing(true)}>
            {t('issueLetter')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={letters}>
          <DataTable
            rows={letters.data?.data ?? []}
            rowKey={(l) => l.id}
            columns={[
              { key: 'number', header: t('col.number'), cell: (l) => <span className="t-mono">{l.number}</span> },
              { key: 'kind', header: t('col.kind'), cell: (l) => label(l.kind) },
              { key: 'unit', header: t('col.unit'), cell: (l) => <span className="t-mono">{l.unitCode}</span> },
              { key: 'for', header: t('col.for'), cell: (l) => l.subjectName ?? <span className="t-secondary">{t('erased')}</span> },
              { key: 'issued', header: t('col.issued'), cell: (l) => fmt.dateTime(l.issuedAt) },
              { key: 'status', header: c('status'), cell: (l) => <StatusBadge status={l.status} /> },
              {
                key: 'actions',
                header: '',
                cell: (l) => (
                  <span className="row">
                    {l.subjectName ? (
                      <a className="table__link" href={`/api/v1/staff/official-letters/${l.id}/pdf`}>
                        {t('pdf')}
                      </a>
                    ) : null}
                    {l.status === 'valid' ? <Button onClick={() => setRevoking(l)}>{t('revoke')}</Button> : null}
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
        title={t('issueLetter')}
        description={t('issueDescription')}
        onSubmit={() => form.unitId && form.accountId && issue.mutate()}
        footer={
          <>
            <Button onClick={() => setIssuing(false)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={issue.isPending} disabled={!form.unitId || !form.accountId || (form.kind === 'no_objection' && !form.subject.trim())}>
              {t('issue')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('kind')}>
            {(p) => (
              <Select {...p} value={form.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('unitId')}>{(p) => <Input {...p} value={form.unitId} onChange={set('unitId')} />}</Field>
          <Field label={t('accountId')}>{(p) => <Input {...p} value={form.accountId} onChange={set('accountId')} />}</Field>
          <Field label={t('addressee')} hint={t('addresseeHint')}>
            {(p) => <Input {...p} maxLength={150} value={form.addressee} onChange={set('addressee')} />}
          </Field>
          <Field label={t('subject')} hint={form.kind === 'no_objection' ? t('subjectRequired') : t('optional')}>
            {(p) => <Input {...p} maxLength={300} value={form.subject} onChange={set('subject')} />}
          </Field>
          <ErrorAlert error={issue.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('revokeTitle', { number: revoking?.number })}
        description={t('revokeDescription')}
        codes={REASON_CODES.officialLetterRevoke}
        confirmLabel={t('revoke')}
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(code) => revoke.mutate(code)}
      />
    </>
  );
}
