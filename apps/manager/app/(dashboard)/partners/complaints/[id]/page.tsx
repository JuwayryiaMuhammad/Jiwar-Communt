'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, ButtonLink, Card, Dialog, Field, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { COMPENSATION_TEXT, compensationsFor, OUTCOME_TEXT } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerComplaint } from '@/lib/queries';

function Decide({ complaint, onClose }: { complaint: PartnerComplaint; onClose: () => void }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<'upheld' | 'not_upheld'>('upheld');
  const [compensation, setCompensation] = useState('none');
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/partner-complaints/{id}/decide', {
          params: { path: { id: complaint.id } },
          body: { outcome, compensation },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: () => {
        toast.show('Decided. The resident was told.');
        onClose();
      },
    },
  );
  const choices = compensationsFor(outcome);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Decide this complaint"
      description="Once. A credit note is issued in Finance by its own page: nothing is paid here."
      onSubmit={() => decide.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={decide.isPending}>
            Decide
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Outcome">
          {(p) => (
            <Select
              {...p}
              value={outcome}
              onChange={(e) => {
                const next = e.target.value as 'upheld' | 'not_upheld';
                setOutcome(next);
                if (!compensationsFor(next).includes(compensation)) setCompensation('none');
              }}
            >
              {Object.entries(OUTCOME_TEXT).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What the management arranges">
          {(p) => (
            <Select {...p} value={compensation} onChange={(e) => setCompensation(e.target.value)}>
              {choices.map((value) => (
                <option key={value} value={value}>
                  {COMPENSATION_TEXT[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={decide.error} />
      </div>
    </Dialog>
  );
}

/** One complaint against a partner (ADR 0060). */
export default function PartnerComplaintPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const complaint = useQuery({ queryKey: keys.partnerComplaint(id), queryFn: () => fetchers.partnerComplaint(id), enabled: allowed });
  const [deciding, setDeciding] = useState(false);
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners/complaints" label="Partner complaints" />} title="Complaint" />
        <ForbiddenState />
      </>
    );
  const c = complaint.data;
  return (
    <>
      <PageHeader
        back={<Back href="/partners/complaints" label="Partner complaints" />}
        title={c ? `${c.managementRequestNumber} · ${c.partner.nameEn}` : 'Complaint'}
        actions={
          c ? (
            <>
              {can('requests.handle') ? (
                <ButtonLink href={`/management-requests/${c.managementRequestId}`}>Open the conversation</ButtonLink>
              ) : null}
              {c.outcome ? null : (
                <Button variant="primary" onClick={() => setDeciding(true)}>
                  Decide
                </Button>
              )}
            </>
          ) : null
        }
      />
      <QueryState query={complaint}>
        {c ? (
          <Card>
            <dl className="dl">
              <dt>Request</dt>
              <dd className="t-mono">{c.requestNumber}</dd>
              <dt>Reason</dt>
              <dd>{humanize(c.reason)}</dd>
              <dt>Asks</dt>
              <dd>
                {humanize(c.compensationAsk)}
                {c.requestedAmount ? ` · ${c.requestedAmount} EGP` : ''}
              </dd>
              <dt>Made</dt>
              <dd>{formatDateTime(c.createdAt)}</dd>
              <dt>Decision</dt>
              <dd>
                {c.outcome
                  ? `${OUTCOME_TEXT[c.outcome]} · ${COMPENSATION_TEXT[c.compensation ?? 'none']} · ${c.decidedAt ? formatDateTime(c.decidedAt) : ''}`
                  : 'Not decided yet'}
              </dd>
            </dl>
          </Card>
        ) : null}
      </QueryState>
      {deciding && c ? <Decide complaint={c} onClose={() => setDeciding(false)} /> : null}
    </>
  );
}
