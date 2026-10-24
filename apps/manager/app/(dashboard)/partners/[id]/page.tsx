'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, ConfirmDialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { DeskLinkCard } from '@/components/partners/desk-link-card';
import { DetailsForm } from '@/components/partners/details-form';
import { HoursEditor } from '@/components/partners/hours-editor';
import { CATEGORY_TEXT, ratingText } from '@/components/partners/logic';
import { PricesEditor } from '@/components/partners/prices-editor';
import { ServicesEditor } from '@/components/partners/services-editor';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['details', 'services', 'hours', 'prices', 'desk'] as const;
type Tab = (typeof TABS)[number];

/** One partner (ADR 0060): who it is, what it does, its hours, prices and desk link, and its standing. */
export default function PartnerPage() {
  const { id } = useParams<{ id: string }>();
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
        toast.show('Suspended. Its live requests were cancelled; those who asked or follow it were told, with alternatives.');
      },
    },
  );
  const reinstate = useAction(() => unwrap(api.POST('/api/v1/staff/partners/{id}/reinstate', { params: { path: { id } } })), {
    invalidate: [keys.partnersAll],
    onDone: () => {
      setReinstating(false);
      toast.show('Reinstated. It takes requests again.');
    },
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners" label="Partners" />} title="Partner" />
        <ForbiddenState />
      </>
    );
  const p = partner.data;
  return (
    <>
      <PageHeader
        back={<Back href="/partners" label="Partners" />}
        title={p?.nameEn ?? 'Partner'}
        description={
          p
            ? `${[...new Set(p.services.map((s) => CATEGORY_TEXT[s.category] ?? s.category))].join(', ')} · ${ratingText(p.rating)} · listed ${formatDateTime(p.listedAt)}`
            : undefined
        }
        actions={
          p ? (
            p.status === 'active' ? (
              <Button variant="danger" onClick={() => setSuspending(true)}>
                Suspend
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setReinstating(true)}>
                Reinstate
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
                    {humanize(p.suspendedReason ?? '')} · {p.suspendedAt ? formatDateTime(p.suspendedAt) : ''}
                  </span>
                </span>
              </Card>
            ) : null}
            <Segmented<Tab>
              label="Section"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'details', label: 'Details' },
                { value: 'services', label: 'Services' },
                { value: 'hours', label: 'Hours' },
                { value: 'prices', label: 'Prices' },
                { value: 'desk', label: 'Desk link' },
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
        title="Suspend this partner?"
        description="Its live requests are cancelled and its desk closes. Those who asked it or keep it as a favourite are told, never why, and offered alternatives."
        codes={REASON_CODES.partnerSuspend}
        confirmLabel="Suspend"
        danger
        pending={suspend.isPending}
        error={<ErrorAlert error={suspend.error} />}
        onConfirm={(reasonCode) => suspend.mutate(reasonCode)}
      />
      <ConfirmDialog
        open={reinstating}
        onClose={() => setReinstating(false)}
        title="Reinstate this partner?"
        description="It takes requests again; its desk link works again if it has not expired. Nobody is told."
        confirmLabel="Reinstate"
        pending={reinstate.isPending}
        error={<ErrorAlert error={reinstate.error} />}
        onConfirm={() => reinstate.mutate()}
      />
    </>
  );
}
