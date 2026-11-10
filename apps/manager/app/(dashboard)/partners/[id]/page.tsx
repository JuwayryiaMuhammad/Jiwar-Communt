'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  ConfirmDialog,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { localName } from '@/components/management-requests/logic';
import { DeskLinkCard } from '@/components/partners/desk-link-card';
import { DetailsForm } from '@/components/partners/details-form';
import { HoursEditor } from '@/components/partners/hours-editor';
import { ratingText, word } from '@/components/partners/logic';
import { PricesEditor } from '@/components/partners/prices-editor';
import { ServicesEditor } from '@/components/partners/services-editor';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-list';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-list';

const TABS = ['details', 'services', 'hours', 'prices', 'desk'] as const;
type Tab = (typeof TABS)[number];

/** One partner (ADR 0060): who it is, what it does, its hours, prices and desk link, and its standing. */
export default function PartnerPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const partner = useQuery({ queryKey: keys.partner(id), queryFn: () => fetchers.partner(id), enabled: allowed });
  const [tab, setTab] = useTab<Tab>(TABS, 'details');
  const [suspending, setSuspending] = useState(false);
  const [reinstating, setReinstating] = useState(false);
  const suspend = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/partners/{id}/suspend', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.partnersAll],
      onDone: () => {
        setSuspending(false);
        toast.show(t('suspended'));
      },
    },
  );
  const reinstate = useAction(() => unwrap(api.POST('/api/v1/staff/partners/{id}/reinstate', { params: { path: { id } } })), {
    invalidate: [keys.partnersAll],
    onDone: () => {
      setReinstating(false);
      toast.show(t('reinstated'));
    },
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners" label={t('title')} />} title={t('partner')} />
        <ForbiddenState />
      </>
    );
  const p = partner.data;
  return (
    <>
      <PageHeader
        back={<Back href="/partners" label={t('title')} />}
        title={p ? localName(locale, p) : t('partner')}
        description={
          p
            ? t('summary', {
                categories: f.list([...new Set(p.services.map((s) => word(codes, 'category', s.category)))]),
                rating: ratingText(codes, p.rating),
                date: f.dateTime(p.listedAt),
              })
            : undefined
        }
        actions={
          p ? (
            p.status === 'active' ? (
              <Button variant="danger" onClick={() => setSuspending(true)}>
                {t('suspend')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setReinstating(true)}>
                {t('reinstate')}
              </Button>
            )
          ) : null
        }
      />
      <QueryState query={partner}>
        {p ? (
          <div className="stack">
            {p.status === 'suspended' ? (
              <Card>
                <span className="row" style={{ gap: 8 }}>
                  <StatusBadge status="suspended" />
                  <span>
                    {label(p.suspendedReason)} · {p.suspendedAt ? f.dateTime(p.suspendedAt) : ''}
                  </span>
                </span>
              </Card>
            ) : null}
            <Segmented<Tab>
              label={t('section')}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'details', label: t('tab.details') },
                { value: 'services', label: t('tab.services') },
                { value: 'hours', label: t('tab.hours') },
                { value: 'prices', label: t('tab.prices') },
                { value: 'desk', label: t('tab.desk') },
              ]}
            />
            {tab === 'details' ? <DetailsForm key={p.updatedAt} partner={p} /> : null}
            {tab === 'services' ? <ServicesEditor key={p.updatedAt} partner={p} /> : null}
            {tab === 'hours' ? <HoursEditor key={p.updatedAt} partner={p} /> : null}
            {tab === 'prices' ? <PricesEditor key={p.updatedAt} partner={p} /> : null}
            {tab === 'desk' ? <DeskLinkCard partner={p} /> : null}
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={suspending}
        onClose={() => setSuspending(false)}
        title={t('suspendTitle')}
        description={t('suspendDescription')}
        codes={REASON_CODES.partnerSuspend}
        confirmLabel={t('suspend')}
        danger
        pending={suspend.isPending}
        error={<ErrorAlert error={suspend.error} />}
        onConfirm={(reasonCode) => suspend.mutate(reasonCode)}
      />
      <ConfirmDialog
        open={reinstating}
        onClose={() => setReinstating(false)}
        title={t('reinstateTitle')}
        description={t('reinstateDescription')}
        confirmLabel={t('reinstate')}
        pending={reinstate.isPending}
        error={<ErrorAlert error={reinstate.error} />}
        onConfirm={() => reinstate.mutate()}
      />
    </>
  );
}
