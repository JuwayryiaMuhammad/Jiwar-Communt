'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/market-main';
import en from '@/messages/en/market-main';

type Listing = Schema<'StaffListingView'>;
type Report = Schema<'MarketReportView'>;
type Shop = Schema<'StaffShopView'>;
type Tab = 'review' | 'reports' | 'shops' | 'settings';
const KEY = ['market'] as const;
const TABS: Tab[] = ['review', 'reports', 'shops', 'settings'];

/** A decision that takes a code from one of the closed lists. */
function WithCode({
  title,
  codes,
  confirm,
  danger,
  run,
  onClose,
}: {
  title: string;
  codes: readonly string[];
  confirm: string;
  danger?: boolean;
  run: (code: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [code, setCode] = useState('');
  const act = useAction(() => run(code), {
    invalidate: [KEY],
    onDone: () => {
      toast.show(t('doneTold'));
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      onSubmit={() => code && act.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={act.isPending} disabled={!code}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('why')} error={fieldError(act.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('choose')}</option>
              {codes.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={act.error} />
      </div>
    </Dialog>
  );
}

/** Listings waiting for a handler, and those reported by enough units. */
function Review() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const c = useCommonT();
  const toast = useToast();
  const [status, setStatus] = useState<'pending_review' | 'under_review'>('pending_review');
  const list = useQuery({
    queryKey: [...KEY, 'review', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/review', { params: { query: { status } } })),
  });
  const approve = useAction((id: string) => unwrap(api.POST('/api/v1/market/review/{id}/approve', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show(t('approved')),
  });
  const [deciding, setDeciding] = useState<{ listing: Listing; action: 'reject' | 'remove' } | null>(null);
  return (
    <div className="stack">
      <Segmented
        label={t('queue')}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending_review', label: t('queue.pending_review') },
          { value: 'under_review', label: t('queue.under_review') },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Listing>
            rows={list.data?.data}
            rowKey={(l) => l.id}
            empty={t('nothingWaiting')}
            columns={[
              { key: 't', header: t('listing'), cell: (l) => l.title ?? '—' },
              { key: 'k', header: c('kind'), cell: (l) => label(l.kind) },
              { key: 'p', header: t('price'), cell: (l) => (l.price ? f.money(l.price) : '—') },
              { key: 's', header: t('seller'), cell: (l) => `${l.sellerAccount.fullName ?? '—'} · ${l.sellerUnitCode ?? '—'}` },
              { key: 'd', header: t('listed'), cell: (l) => f.dateTime(l.createdAt) },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (l) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(l.id)}>
                      {status === 'pending_review' ? t('approve') : t('putBack')}
                    </Button>
                    {status === 'pending_review' ? (
                      <Button size="sm" onClick={() => setDeciding({ listing: l, action: 'reject' })}>
                        {t('turnDown')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" onClick={() => setDeciding({ listing: l, action: 'remove' })}>
                      {t('takeOff')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={approve.error} />
      {deciding ? (
        <WithCode
          title={deciding.action === 'reject' ? t('turnDownTitle', { title: deciding.listing.title ?? '' }) : t('takeOffTitle', { title: deciding.listing.title ?? '' })}
          codes={deciding.action === 'reject' ? REASON_CODES.marketListingReject : REASON_CODES.marketListingRemove}
          confirm={deciding.action === 'reject' ? t('turnDown') : t('takeOff')}
          danger={deciding.action === 'remove'}
          run={(reasonCode) =>
            unwrap(
              deciding.action === 'reject'
                ? api.POST('/api/v1/market/review/{id}/reject', { params: { path: { id: deciding.listing.id } }, body: { reasonCode } })
                : api.POST('/api/v1/market/review/{id}/remove', { params: { path: { id: deciding.listing.id } }, body: { reasonCode } }),
            )
          }
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </div>
  );
}

/** Residents' reports of listings; closing one `removed` takes the listing off. */
function Reports() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const list = useQuery({
    queryKey: [...KEY, 'reports', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/reports', { params: { query: { status } } })),
  });
  const [closing, setClosing] = useState<Report | null>(null);
  return (
    <div className="stack">
      <Segmented
        label={c('status')}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: label('open') },
          { value: 'closed', label: label('closed') },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Report>
            rows={list.data?.data}
            rowKey={(r) => r.id}
            empty={t('reports.noReports')}
            columns={[
              { key: 'l', header: t('listing'), cell: (r) => r.listingTitle ?? '—' },
              { key: 'r', header: t('reports.report'), cell: (r) => <Badge tone="beige">{label(r.reasonCode)}</Badge> },
              { key: 'n', header: c('note'), cell: (r) => r.note ?? '—' },
              { key: 'w', header: t('reports.by'), cell: (r) => `${r.reporter.fullName ?? '—'} · ${r.reporterUnitCode ?? '—'}` },
              { key: 'o', header: t('reports.outcome'), cell: (r) => (r.outcome ? label(r.outcome) : '—') },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(r)}>
                      {c('close')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {closing ? (
        <WithCode
          title={t('reports.closeTitle', { title: closing.listingTitle ?? '' })}
          codes={REASON_CODES.marketReportOutcome}
          confirm={c('close')}
          run={(reasonCode) => unwrap(api.POST('/api/v1/market/reports/{id}/close', { params: { path: { id: closing.id } }, body: { reasonCode } }))}
          onClose={() => setClosing(null)}
        />
      ) : null}
    </div>
  );
}

/** Residents' small shops: open a waiting one, suspend or reinstate, turn down. */
function Shops() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'active' | 'suspended' | 'closed'>('pending');
  const list = useQuery({
    queryKey: [...KEY, 'shops', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/shop-review', { params: { query: { status } } })),
  });
  const approve = useAction((id: string) => unwrap(api.POST('/api/v1/market/shop-review/{id}/approve', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show(t('shops.opened')),
  });
  const [deciding, setDeciding] = useState<{ shop: Shop; action: 'reject' | 'suspend' } | null>(null);
  return (
    <div className="stack">
      <Segmented
        label={c('status')}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending', label: t('shops.status.pending') },
          { value: 'active', label: t('shops.status.active') },
          { value: 'suspended', label: t('shops.status.suspended') },
          { value: 'closed', label: t('shops.status.closed') },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Shop>
            rows={list.data?.data}
            rowKey={(s) => s.id}
            empty={c('none')}
            columns={[
              { key: 'n', header: t('shops.shop'), cell: (s) => (locale === 'ar' ? (s.nameAr ?? s.nameEn) : s.nameEn) ?? '—' },
              { key: 'c', header: c('category'), cell: (s) => label(s.category) },
              { key: 'o', header: t('shops.owner'), cell: (s) => `${s.owner.fullName ?? '—'} · ${s.ownerUnitCode ?? '—'}` },
              { key: 'l', header: t('shops.live'), cell: (s) => <span className="t-num">{s.liveListings}</span> },
              { key: 'r', header: t('shops.why'), cell: (s) => (s.reasonCode ? label(s.reasonCode) : '—') },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (s) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {s.status === 'pending' || s.status === 'suspended' ? (
                      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(s.id)}>
                        {s.status === 'pending' ? t('shops.open') : t('shops.reinstate')}
                      </Button>
                    ) : null}
                    {s.status === 'pending' ? (
                      <Button size="sm" onClick={() => setDeciding({ shop: s, action: 'reject' })}>
                        {t('turnDown')}
                      </Button>
                    ) : null}
                    {s.status === 'active' ? (
                      <Button size="sm" variant="danger" onClick={() => setDeciding({ shop: s, action: 'suspend' })}>
                        {t('shops.suspend')}
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={approve.error} />
      {deciding ? (
        <WithCode
          title={
            deciding.action === 'reject'
              ? t('shops.turnDownTitle', { name: deciding.shop.nameEn ?? '' })
              : t('shops.suspendTitle', { name: deciding.shop.nameEn ?? '' })
          }
          codes={deciding.action === 'reject' ? REASON_CODES.marketShopReject : REASON_CODES.marketShopSuspend}
          confirm={deciding.action === 'reject' ? t('turnDown') : t('shops.suspend')}
          danger
          run={(reasonCode) =>
            unwrap(
              deciding.action === 'reject'
                ? api.POST('/api/v1/market/shop-review/{id}/reject', { params: { path: { id: deciding.shop.id } }, body: { reasonCode } })
                : api.POST('/api/v1/market/shop-review/{id}/suspend', { params: { path: { id: deciding.shop.id } }, body: { reasonCode } }),
            )
          }
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </div>
  );
}

/** Every category the market knows (ADR 0071's closed list). */
const CATEGORIES = [
  'furniture',
  'electronics',
  'appliances',
  'clothing',
  'kids',
  'books',
  'sports',
  'vehicles',
  'home_garden',
  'services',
  'food',
  'real_estate',
  'other',
] as const;

/**
 * The market's settings: review, limits, days, the reports that hide; and
 * its rules (ADR 0083): commercial listings blocked, the categories it
 * takes, the listings one unit may have open. A rule applies to new and
 * edited listings; what is open stays.
 */
function Settings() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const settings = useQuery({ queryKey: [...KEY, 'settings'], queryFn: () => unwrap(api.GET('/api/v1/market/settings')) });
  const [form, setForm] = useState({
    requiresReview: true,
    maxLivePerAccount: '10',
    expiryDays: '30',
    reportHideThreshold: '3',
    commercialBlocked: false,
    allowedCategories: [...CATEGORIES] as string[],
    maxLivePerUnit: '10',
  });
  useEffect(() => {
    if (settings.data)
      setForm({
        requiresReview: settings.data.requiresReview,
        maxLivePerAccount: String(settings.data.maxLivePerAccount),
        expiryDays: String(settings.data.expiryDays),
        reportHideThreshold: String(settings.data.reportHideThreshold),
        commercialBlocked: settings.data.commercialBlocked,
        allowedCategories: [...settings.data.allowedCategories],
        maxLivePerUnit: String(settings.data.maxLivePerUnit),
      });
  }, [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/market/settings', {
          body: {
            requiresReview: form.requiresReview,
            maxLivePerAccount: Number(form.maxLivePerAccount),
            expiryDays: Number(form.expiryDays),
            reportHideThreshold: Number(form.reportHideThreshold),
            commercialBlocked: form.commercialBlocked,
            allowedCategories: form.allowedCategories as (typeof CATEGORIES)[number][],
            maxLivePerUnit: Number(form.maxLivePerUnit),
          },
        }),
      ),
    { invalidate: [KEY], onDone: () => toast.show(t('settings.saved')) },
  );
  const number = (key: 'maxLivePerAccount' | 'expiryDays' | 'reportHideThreshold' | 'maxLivePerUnit', text: string, hint: string) => (
    <Field label={text} hint={hint} error={fieldError(save.error, key)}>
      {(p) => <Input {...p} className="ltr" inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </Field>
  );
  const toggle = (category: string) =>
    setForm({
      ...form,
      allowedCategories: form.allowedCategories.includes(category)
        ? form.allowedCategories.filter((x) => x !== category)
        : [...form.allowedCategories, category],
    });
  return (
    <Card>
      <CardHeader title={t('settings.title')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label={t('settings.review')} hint={t('settings.reviewHint')}>
              {(p) => (
                <Select {...p} value={form.requiresReview ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, requiresReview: e.target.value === 'yes' })}>
                  <option value="yes">{t('settings.reviewAll')}</option>
                  <option value="no">{t('settings.reviewNone')}</option>
                </Select>
              )}
            </Field>
            {number('maxLivePerAccount', t('settings.maxPerAccount'), t('settings.range50'))}
            {number('maxLivePerUnit', t('settings.maxPerUnit'), t('settings.maxPerUnitHint'))}
            {number('expiryDays', t('settings.expiry'), t('settings.range180'))}
            {number('reportHideThreshold', t('settings.threshold'), t('settings.range20'))}
            <Field label={t('settings.commercial')} hint={t('settings.commercialHint')}>
              {(p) => (
                <Select
                  {...p}
                  value={form.commercialBlocked ? 'blocked' : 'allowed'}
                  onChange={(e) => setForm({ ...form, commercialBlocked: e.target.value === 'blocked' })}
                >
                  <option value="allowed">{t('settings.allowed')}</option>
                  <option value="blocked">{t('settings.blocked')}</option>
                </Select>
              )}
            </Field>
            <fieldset className="stack stack--sm">
              <legend>{t('settings.categories')}</legend>
              {CATEGORIES.map((category) => (
                <label key={category} style={{ display: 'flex', gap: 8 }}>
                  <input type="checkbox" checked={form.allowedCategories.includes(category)} onChange={() => toggle(category)} />
                  {label(category)}
                </label>
              ))}
              {fieldError(save.error, 'allowedCategories') ? <p className="t-error">{fieldError(save.error, 'allowedCategories')}</p> : null}
            </fieldset>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={form.allowedCategories.length === 0} onClick={() => save.mutate(undefined)}>
                {c('save')}
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * The market (ADR 0071): residents' listings waiting for review or
 * reported, the reports, the small shops and the settings. Sellers are
 * named here, for the handlers; residents only ever see a building.
 */
export default function MarketPage() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('review');
  if (ready && !can('market.handle'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Segmented<Tab> label={t('section')} value={tab} onChange={setTab} options={TABS.map((value) => ({ value, label: t(`tab.${value}`) }))} />
        {tab === 'review' ? <Review /> : tab === 'reports' ? <Reports /> : tab === 'shops' ? <Shops /> : <Settings />}
      </div>
    </>
  );
}
