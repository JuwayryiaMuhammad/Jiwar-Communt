'use client';

import { ApiError, fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, Field, ForbiddenState, Input, PageHeader, Select, SkeletonRows, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { LinesEditor } from '@/components/purchase-orders/lines-editor';
import { BudgetLineSelect, useStockChoices, useVendorChoices } from '@/components/purchase-orders/pickers';
import { lineFromRequest, linesBody, linesReady, newLine, type FormLine } from '@/components/purchase-orders/po';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseRequest, type Tender } from '@/lib/queries';
import commonAr from '@/messages/ar/po-common';
import ar from '@/messages/ar/po-raise';
import commonEn from '@/messages/en/po-common';
import en from '@/messages/en/po-raise';

const today = () => new Date().toLocaleDateString('en-CA');
const SOURCE_REASONS = [
  'request_not_approved',
  'already_ordered',
  'vendor_mismatch',
  'tender_not_awarded',
  'contract_scheduled',
  'award_exceeded',
] as const;

/** What a refused source says, beyond the code's one sentence. */
function SourceReason({ error }: { error: unknown }) {
  const w = useT(commonEn, commonAr);
  const f = useFormat();
  if (!(error instanceof ApiError) || error.code !== 'PURCHASE_ORDER_SOURCE_INVALID') return null;
  const reason = SOURCE_REASONS.find((r) => r === error.params.reason);
  if (!reason) return null;
  return (
    <p className="hint">
      {w(`source.${reason}`, {
        awarded: f.money(String(error.params.awarded ?? '')),
        ordered: f.money(String(error.params.ordered ?? '')),
      })}
    </p>
  );
}

interface Source {
  requestId: string;
  tenderId: string;
  /** Read, when the caller may read it. */
  request?: PurchaseRequest;
  tender?: Tender;
  /** The award’s vendor, when its contract could be read. */
  tenderVendorId?: string;
}

function RaiseForm({ source }: { source: Source }) {
  const t = useT(en, ar);
  const router = useRouter();
  const toast = useToast();
  const { request, tender } = source;
  const { vendors, allowed: readsVendors } = useVendorChoices();
  const { items, allowed: stockAllowed } = useStockChoices();
  const [key] = useState(() => crypto.randomUUID());
  const awardedBid = tender?.bids.find((b) => b.id === tender.awardedBidId);
  const [vendorId, setVendorId] = useState(request?.vendorId ?? source.tenderVendorId ?? '');
  const [budgetLineId, setBudgetLineId] = useState(request?.budgetLineId ?? tender?.budgetLineId ?? '');
  const [deliveryOn, setDeliveryOn] = useState(request?.neededBy && request.neededBy >= today() ? request.neededBy : '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<FormLine[]>(() => {
    if (request) return [lineFromRequest(request)];
    if (tender)
      return [
        {
          ...newLine('service'),
          description: tender.title.slice(0, 200),
          quantity: '1',
          unit: 'lot',
          unitPrice: awardedBid && !awardedBid.sealed && awardedBid.amount ? awardedBid.amount : '',
        },
      ];
    return [newLine('goods')];
  });
  // A source that could not be read still gives the order its vendor and budget line, as the API takes them.
  const sourceUnread = (source.requestId !== '' && !request) || (source.tenderId !== '' && !tender);
  const vendorLocked = Boolean(request?.vendorId ?? source.tenderVendorId);
  const vendorFilled = vendorId !== '' || source.tenderId !== '' || sourceUnread;
  const budgetFromSource = Boolean(request?.budgetLineId ?? tender?.budgetLineId);
  const raise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/purchase-orders', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            ...(source.requestId ? { purchaseRequestId: source.requestId } : {}),
            ...(source.tenderId ? { tenderId: source.tenderId } : {}),
            ...(vendorId ? { vendorId } : {}),
            ...(budgetLineId ? { budgetLineId } : {}),
            deliveryOn,
            ...(note.trim() ? { note: note.trim() } : {}),
            lines: linesBody(lines),
          },
        }),
      ),
    {
      invalidate: [keys.purchaseOrdersAll, keys.purchasesAll, keys.tendersAll, keys.budgetsAll],
      onDone: (o) => {
        toast.show(t('raised', { reference: o.reference }));
        router.push(`/purchase-orders/${o.id}`);
      },
    },
  );
  const err = (field: string) => fieldError(raise.error, field);
  const ready = linesReady(lines) && deliveryOn !== '' && vendorFilled && (budgetFromSource || sourceUnread || budgetLineId !== '');
  const vendorOptionKnown = vendors.some((v) => v.id === vendorId);
  return (
    <div className="stack">
      {request ? <p className="t-secondary">{t('fromRequest', { reference: request.reference, title: request.title })}</p> : null}
      {tender ? <p className="t-secondary">{t('fromTender', { reference: tender.reference, title: tender.title })}</p> : null}
      {sourceUnread ? <p className="hint">{t('sourceGone')}</p> : null}
      <Card>
        <div className="form">
          <div className="form__row">
            {readsVendors || vendorLocked ? (
              <Field label={t('vendor')} error={err('vendorId')}>
                {(p) => (
                  <Select {...p} value={vendorId} disabled={vendorLocked} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">{source.tenderId && !vendorLocked ? t('vendorFromAward') : t('chooseVendor')}</option>
                    {vendorId && !vendorOptionKnown ? <option value={vendorId}>{t('vendorFromSource')}</option> : null}
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {`${v.reference} · ${v.name}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <p className="hint">{t('vendorNoAccess')}</p>
            )}
            <BudgetLineSelect
              value={budgetLineId}
              onChange={setBudgetLineId}
              error={err('budgetLineId')}
              hint={budgetFromSource ? (request ? t('budgetFromRequest') : t('budgetFromTender')) : undefined}
            />
          </div>
          <div className="form__row">
            <Field label={t('deliveryOn')} hint={t('deliveryHint')} error={err('deliveryOn')}>
              {(p) => <Input {...p} type="date" min={today()} value={deliveryOn} onChange={(e) => setDeliveryOn(e.target.value)} />}
            </Field>
          </div>
          <Field label={t('note')} hint={t('noteHint')} error={err('note')}>
            {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Card>
      <Card>
        <SectionHeader title={t('linesTitle')} description={t('linesHint')} />
        <LinesEditor lines={lines} onChange={setLines} items={items} stockAllowed={stockAllowed} error={raise.error} />
      </Card>
      <ErrorAlert error={raise.error} />
      <SourceReason error={raise.error} />
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" loading={raise.isPending} disabled={!ready} onClick={() => raise.mutate(undefined)}>
          {t('submit')}
        </Button>
        <ButtonLink href="/purchase-orders">{t('cancel')}</ButtonLink>
      </div>
    </div>
  );
}

function Raise() {
  const t = useT(en, ar);
  const search = useSearchParams();
  const requestId = search.get('purchaseRequestId') ?? '';
  const tenderId = search.get('tenderId') ?? '';
  const { ready, can } = usePermissions();
  const allowed = can('purchase_orders.raise');
  const request = useQuery({
    queryKey: keys.purchaseRequest(requestId),
    queryFn: () => fetchers.purchaseRequest(requestId),
    enabled: allowed && requestId !== '',
    retry: false,
  });
  const tender = useQuery({ queryKey: keys.tender(tenderId), queryFn: () => fetchers.tender(tenderId), enabled: allowed && tenderId !== '', retry: false });
  const contractId = tender.data?.contractId ?? '';
  // The award’s vendor is its contract’s; a role that cannot read contracts lets the API fill it in.
  const contract = useQuery({
    queryKey: keys.poContract(contractId),
    queryFn: () => fetchers.contract(contractId),
    enabled: allowed && contractId !== '',
    retry: false,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const loading = !ready || request.isLoading || tender.isLoading || contract.isLoading;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {loading ? (
        <SkeletonRows rows={4} />
      ) : (
        <RaiseForm
          source={{
            requestId,
            tenderId,
            request: request.data,
            tender: tender.data,
            tenderVendorId: contract.data?.vendorId,
          }}
        />
      )}
    </>
  );
}

/** Raise a purchase order (ADR 0094): directly, from an approved purchase request or from an awarded tender. */
export default function RaisePage() {
  return (
    <Suspense>
      <Raise />
    </Suspense>
  );
}
