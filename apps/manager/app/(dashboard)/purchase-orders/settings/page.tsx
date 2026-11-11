'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Field, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { settingsReady } from '@/components/purchase-orders/po';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseOrderSettings } from '@/lib/queries';
import ar from '@/messages/ar/po-settings';
import en from '@/messages/en/po-settings';

function Form({ s, canWrite }: { s: PurchaseOrderSettings; canWrite: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [pricePct, setPricePct] = useState(s.pricePct);
  const [quantityPct, setQuantityPct] = useState(s.quantityPct);
  const [amount, setAmount] = useState(s.amount);
  const [above, setAbove] = useState(s.poRequiredAbove ?? '');
  useEffect(() => {
    setPricePct(s.pricePct);
    setQuantityPct(s.quantityPct);
    setAmount(s.amount);
    setAbove(s.poRequiredAbove ?? '');
  }, [s]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/finance/purchase-order-settings', {
          body: {
            pricePct: pricePct.trim(),
            quantityPct: quantityPct.trim(),
            amount: amount.trim(),
            poRequiredAbove: above.trim() === '' ? null : above.trim(),
          },
        }),
      ),
    { invalidate: [keys.purchaseOrderSettings, keys.payablesAll], onDone: () => toast.show(t('saved')) },
  );
  const err = (field: string) => fieldError(save.error, field);
  const ok = settingsReady({ pricePct, quantityPct, amount, poRequiredAbove: above });
  return (
    <div className="stack">
      <Card>
        <SectionHeader title={t('toleranceTitle')} />
        <div className="form">
          <Field label={t('pricePct')} hint={t('priceHint')} error={err('pricePct')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={pricePct} disabled={!canWrite} onChange={(e) => setPricePct(e.target.value)} />}
          </Field>
          <Field label={t('quantityPct')} hint={t('quantityHint')} error={err('quantityPct')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={quantityPct} disabled={!canWrite} onChange={(e) => setQuantityPct(e.target.value)} />}
          </Field>
          <Field label={t('amount')} hint={t('amountHint')} error={err('amount')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={amount} disabled={!canWrite} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
        </div>
      </Card>
      <Card>
        <SectionHeader title={t('requiredTitle')} />
        <div className="form">
          <Field label={t('poRequiredAbove')} hint={t('poRequiredHint')} error={err('poRequiredAbove')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={above} disabled={!canWrite} onChange={(e) => setAbove(e.target.value)} />}
          </Field>
        </div>
      </Card>
      <ErrorAlert error={save.error} />
      {canWrite ? (
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" loading={save.isPending} disabled={!ok} onClick={() => save.mutate(undefined)}>
            {c('save')}
          </Button>
        </div>
      ) : (
        <Badge tone="beige">{t('needsWrite')}</Badge>
      )}
    </div>
  );
}

/**
 * The order and match settings (ADR 0094): the tolerances of the three-way
 * match (price, quantity, amount) and the amount above which an invoice with
 * no contract must name a purchase order. Read with either payables
 * permission, changed with the approval one; applies from the next match.
 */
export default function PurchaseOrderSettingsPage() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const canWrite = can('finance.payables_approve');
  const allowed = canWrite || can('finance.payables');
  const q = useQuery({ queryKey: keys.purchaseOrderSettings, queryFn: fetchers.purchaseOrderSettings, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 12 }}>
            <Link href="/purchase-orders">{t('ordersLink')}</Link>
            <Link href="/finance/payables">{t('payablesLink')}</Link>
          </span>
        }
      />
      <QueryState query={q} rows={4}>
        {q.data ? <Form s={q.data} canWrite={canWrite} /> : null}
      </QueryState>
    </>
  );
}
