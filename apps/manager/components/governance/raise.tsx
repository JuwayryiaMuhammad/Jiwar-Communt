'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { APPROVAL_SUBJECT, APPROVAL_TYPE_TEXT, CATEGORY_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ApprovalType } from '@/lib/queries';

const MAX_ALTERNATIVES = 5;
const MAX_ATTACHMENTS = 5;

/**
 * Raises a matter for the board (ADR 0055): its context and impact, the
 * cost, up to five alternatives and five attachments. An annual budget is
 * raised from its own page (`budgetId` given): its cost is its total. A
 * budget increase names a line of the active budget.
 */
export function RaiseApproval({ onClose, budgetId }: { onClose: () => void; budgetId?: string }) {
  const toast = useToast();
  const router = useRouter();
  const { can } = usePermissions();
  const [key] = useState(() => crypto.randomUUID());
  const [type, setType] = useState<ApprovalType>(budgetId ? 'annual_budget' : 'major_contract');
  const [lineId, setLineId] = useState('');
  const [context, setContext] = useState('');
  const [impact, setImpact] = useState('');
  const [cost, setCost] = useState('');
  const [alternatives, setAlternatives] = useState<{ text: string; cost: string }[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const subject = APPROVAL_SUBJECT[type];
  const active = useQuery({
    queryKey: keys.budgets('active'),
    queryFn: () => fetchers.budgets('active', undefined, 1),
    enabled: subject === 'budget_line',
  });
  const lines = active.data?.data[0]?.lines ?? [];
  const types = (Object.keys(APPROVAL_TYPE_TEXT) as ApprovalType[]).filter(
    (t) => t !== 'annual_budget' && (t !== 'budget_increase' || can('finance.budget')),
  );
  const raise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/approvals', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            type,
            context: context.trim(),
            impact: impact.trim(),
            ...(subject === 'budget' && budgetId ? { budgetId } : {}),
            ...(subject === 'budget_line' && lineId ? { budgetLineId: lineId } : {}),
            ...(type !== 'annual_budget' && cost.trim() ? { cost: cost.trim() } : {}),
            ...(alternatives.length
              ? { alternatives: alternatives.map((a) => ({ text: a.text.trim(), ...(a.cost.trim() ? { cost: a.cost.trim() } : {}) })) }
              : {}),
            ...(files.length ? { attachmentIds: files } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll, keys.budgetsAll],
      onDone: (r) => {
        toast.show('Raised. The board was told; it decides by its deadline.');
        onClose();
        router.push(`/governance/approvals/${r.id}`);
      },
    },
  );
  const err = (f: string) => fieldError(raise.error, f);
  const ready = context.trim() && impact.trim() && (subject !== 'budget_line' || lineId) && alternatives.every((a) => a.text.trim());
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={budgetId ? 'Submit the budget to the board' : 'Raise a matter for the board'}
      description="The board sees the whole package: write it for owners who were not in the office. No one’s personal details."
      onSubmit={() => raise.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!ready}>
            {budgetId ? 'Submit' : 'Raise'}
          </Button>
        </>
      }
    >
      <div className="form">
        {budgetId ? null : (
          <Field label="Type" error={err('type')}>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value as ApprovalType)}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {APPROVAL_TYPE_TEXT[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {subject === 'budget_line' ? (
          <Field label="Line of the active budget" error={err('budgetLineId')}>
            {(p) => (
              <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">{active.isPending ? 'Loading…' : lines.length ? 'Choose a line' : 'No active budget'}</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {CATEGORY_TEXT[l.category]} · {l.remaining} of {l.allowance} EGP left
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Context" error={err('context')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={context} onChange={(e) => setContext(e.target.value)} />}
        </Field>
        <Field label="Impact" error={err('impact')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={impact} onChange={(e) => setImpact(e.target.value)} />}
        </Field>
        {type === 'annual_budget' ? (
          <p className="t-secondary">Its cost is the budget’s total.</p>
        ) : (
          <Field
            label={type === 'budget_increase' || type === 'major_contract' ? 'Cost (EGP)' : 'Cost (EGP, optional)'}
            error={err('cost')}
          >
            {(p) => <Input {...p} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />}
          </Field>
        )}
        <div className="stack">
          <span>Alternatives considered</span>
          {alternatives.map((a, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={`Alternative ${i + 1}`} error={err(`alternatives.${i}.text`)}>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={1000}
                    value={a.text}
                    onChange={(e) => setAlternatives(alternatives.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                )}
              </Field>
              <Field label="Cost (optional)" error={err(`alternatives.${i}.cost`)}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={a.cost}
                    onChange={(e) => setAlternatives(alternatives.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))}
                  />
                )}
              </Field>
              <Button variant="text" onClick={() => setAlternatives(alternatives.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          {alternatives.length < MAX_ALTERNATIVES ? (
            <Button variant="text" onClick={() => setAlternatives([...alternatives, { text: '', cost: '' }])}>
              Add an alternative
            </Button>
          ) : null}
        </div>
        {files.length ? <p className="t-secondary">{files.length} attached.</p> : null}
        <FileUpload
          purpose="approval_attachment"
          label="Attach a quote, a report or a photo"
          disabled={files.length >= MAX_ATTACHMENTS}
          onUploaded={(id) => setFiles((f) => [...f, id])}
        />
        {err('attachmentIds') ? <p className="t-error">{err('attachmentIds')}</p> : null}
        {err('budgetId') ? <p className="t-error">{err('budgetId')}</p> : null}
        <ErrorAlert error={raise.error} />
      </div>
    </Dialog>
  );
}
