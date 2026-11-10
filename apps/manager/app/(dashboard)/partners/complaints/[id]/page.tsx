'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, Dialog, Field, ForbiddenState, PageHeader, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { localName } from '@/components/management-requests/logic';
import { compensationsFor, OUTCOMES, word } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerComplaint } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-complaints';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-complaints';

function Decide({ complaint, onClose }: { complaint: PartnerComplaint; onClose: () => void }) {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
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
        toast.show(t('decide.done'));
        onClose();
      },
    },
  );
  const choices = compensationsFor(outcome);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('decide.title')}
      description={t('decide.description')}
      onSubmit={() => decide.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={decide.isPending}>
            {t('decide')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('outcome')}>
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
              {OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {word(codes, 'outcome', value)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('arrangement')}>
          {(p) => (
            <Select {...p} value={compensation} onChange={(e) => setCompensation(e.target.value)}>
              {choices.map((value) => (
                <option key={value} value={value}>
                  {word(codes, 'compensation', value)}
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
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const complaint = useQuery({ queryKey: keys.partnerComplaint(id), queryFn: () => fetchers.partnerComplaint(id), enabled: allowed });
  const [deciding, setDeciding] = useState(false);
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners/complaints" label={t('title')} />} title={t('complaint')} />
        <ForbiddenState />
      </>
    );
  const cm = complaint.data;
  return (
    <>
      <PageHeader
        back={<Back href="/partners/complaints" label={t('title')} />}
        title={cm ? `${cm.managementRequestNumber} · ${localName(locale, cm.partner)}` : t('complaint')}
        actions={
          cm ? (
            <>
              {can('requests.handle') ? (
                <ButtonLink href={`/management-requests/${cm.managementRequestId}`}>{t('openConversation')}</ButtonLink>
              ) : null}
              {cm.outcome ? null : (
                <Button variant="primary" onClick={() => setDeciding(true)}>
                  {t('decide')}
                </Button>
              )}
            </>
          ) : null
        }
      />
      <QueryState query={complaint}>
        {cm ? (
          <Card>
            <dl className="dl">
              <dt>{t('request')}</dt>
              <dd className="t-mono ltr">{cm.requestNumber}</dd>
              <dt>{c('reason')}</dt>
              <dd>{label(cm.reason)}</dd>
              <dt>{t('col.asks')}</dt>
              <dd>
                {label(cm.compensationAsk)}
                {cm.requestedAmount ? ` · ${f.money(cm.requestedAmount)}` : ''}
              </dd>
              <dt>{t('col.made')}</dt>
              <dd>{f.dateTime(cm.createdAt)}</dd>
              <dt>{t('col.decision')}</dt>
              <dd>
                {cm.outcome
                  ? `${word(codes, 'outcome', cm.outcome)} · ${word(codes, 'compensation', cm.compensation ?? 'none')} · ${cm.decidedAt ? f.dateTime(cm.decidedAt) : ''}`
                  : t('notDecided')}
              </dd>
            </dl>
          </Card>
        ) : null}
      </QueryState>
      {deciding && cm ? <Decide complaint={cm} onClose={() => setDeciding(false)} /> : null}
    </>
  );
}
