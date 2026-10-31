'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Listing = Schema<'StaffListingView'>;
type Report = Schema<'MarketReportView'>;
type Shop = Schema<'StaffShopView'>;
type Tab = 'review' | 'reports' | 'shops' | 'settings';
const KEY = ['market'] as const;
const TABS: { value: Tab; label: string }[] = [
  { value: 'review', label: 'Review' },
  { value: 'reports', label: 'Reports' },
  { value: 'shops', label: 'Shops' },
  { value: 'settings', label: 'Settings' },
];
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

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
  const toast = useToast();
  const [code, setCode] = useState('');
  const act = useAction(() => run(code), {
    invalidate: [KEY],
    onDone: () => {
      toast.show('Done: the resident is told.');
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={act.isPending} disabled={!code}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Why" error={fieldError(act.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose…</option>
              {codes.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
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
  const toast = useToast();
  const [status, setStatus] = useState<'pending_review' | 'under_review'>('pending_review');
  const list = useQuery({
    queryKey: [...KEY, 'review', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/review', { params: { query: { status } } })),
  });
  const approve = useAction((id: string) => unwrap(api.POST('/api/v1/market/review/{id}/approve', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show('On the market: the seller is told.'),
  });
  const [deciding, setDeciding] = useState<{ listing: Listing; action: 'reject' | 'remove' } | null>(null);
  return (
    <div className="stack">
      <Segmented
        label="Queue"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending_review', label: 'Waiting' },
          { value: 'under_review', label: 'Reported' },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Listing>
            rows={list.data?.data}
            rowKey={(l) => l.id}
            empty="Nothing waiting"
            columns={[
              { key: 't', header: 'Listing', cell: (l) => l.title ?? '—' },
              { key: 'k', header: 'Kind', cell: (l) => label(l.kind) },
              { key: 'p', header: 'Price', cell: (l) => (l.price ? `${l.price} EGP` : '—') },
              { key: 's', header: 'Seller', cell: (l) => `${l.sellerAccount.fullName ?? '—'} · ${l.sellerUnitCode ?? '—'}` },
              { key: 'd', header: 'Listed', cell: (l) => formatDateTime(l.createdAt) },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (l) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(l.id)}>
                      {status === 'pending_review' ? 'Approve' : 'Put back'}
                    </Button>
                    {status === 'pending_review' ? (
                      <Button size="sm" onClick={() => setDeciding({ listing: l, action: 'reject' })}>
                        Turn down
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" onClick={() => setDeciding({ listing: l, action: 'remove' })}>
                      Take off
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
          title={deciding.action === 'reject' ? `Turn down “${deciding.listing.title ?? ''}”` : `Take “${deciding.listing.title ?? ''}” off the market`}
          codes={deciding.action === 'reject' ? REASON_CODES.marketListingReject : REASON_CODES.marketListingRemove}
          confirm={deciding.action === 'reject' ? 'Turn down' : 'Take off'}
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
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const list = useQuery({
    queryKey: [...KEY, 'reports', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/reports', { params: { query: { status } } })),
  });
  const [closing, setClosing] = useState<Report | null>(null);
  return (
    <div className="stack">
      <Segmented
        label="Status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Report>
            rows={list.data?.data}
            rowKey={(r) => r.id}
            empty="No reports"
            columns={[
              { key: 'l', header: 'Listing', cell: (r) => r.listingTitle ?? '—' },
              { key: 'r', header: 'Report', cell: (r) => <Badge tone="beige">{label(r.reasonCode)}</Badge> },
              { key: 'n', header: 'Note', cell: (r) => r.note ?? '—' },
              { key: 'w', header: 'By', cell: (r) => `${r.reporter.fullName ?? '—'} · ${r.reporterUnitCode ?? '—'}` },
              { key: 'o', header: 'Outcome', cell: (r) => (r.outcome ? label(r.outcome) : '—') },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(r)}>
                      Close
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {closing ? (
        <WithCode
          title={`Close the report on “${closing.listingTitle ?? ''}”`}
          codes={REASON_CODES.marketReportOutcome}
          confirm="Close"
          run={(reasonCode) => unwrap(api.POST('/api/v1/market/reports/{id}/close', { params: { path: { id: closing.id } }, body: { reasonCode } }))}
          onClose={() => setClosing(null)}
        />
      ) : null}
    </div>
  );
}

/** Residents' small shops: open a waiting one, suspend or reinstate, turn down. */
function Shops() {
  const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'active' | 'suspended' | 'closed'>('pending');
  const list = useQuery({
    queryKey: [...KEY, 'shops', status],
    queryFn: () => unwrap(api.GET('/api/v1/market/shop-review', { params: { query: { status } } })),
  });
  const approve = useAction((id: string) => unwrap(api.POST('/api/v1/market/shop-review/{id}/approve', { params: { path: { id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show('Open: the owner is told.'),
  });
  const [deciding, setDeciding] = useState<{ shop: Shop; action: 'reject' | 'suspend' } | null>(null);
  return (
    <div className="stack">
      <Segmented
        label="Status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending', label: 'Waiting' },
          { value: 'active', label: 'Open' },
          { value: 'suspended', label: 'Suspended' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Shop>
            rows={list.data?.data}
            rowKey={(s) => s.id}
            empty="None"
            columns={[
              { key: 'n', header: 'Shop', cell: (s) => s.nameEn ?? '—' },
              { key: 'c', header: 'Category', cell: (s) => label(s.category) },
              { key: 'o', header: 'Owner', cell: (s) => `${s.owner.fullName ?? '—'} · ${s.ownerUnitCode ?? '—'}` },
              { key: 'l', header: 'Live listings', cell: (s) => <span className="t-num">{s.liveListings}</span> },
              { key: 'r', header: 'Why', cell: (s) => (s.reasonCode ? label(s.reasonCode) : '—') },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (s) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {s.status === 'pending' || s.status === 'suspended' ? (
                      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(s.id)}>
                        {s.status === 'pending' ? 'Open' : 'Reinstate'}
                      </Button>
                    ) : null}
                    {s.status === 'pending' ? (
                      <Button size="sm" onClick={() => setDeciding({ shop: s, action: 'reject' })}>
                        Turn down
                      </Button>
                    ) : null}
                    {s.status === 'active' ? (
                      <Button size="sm" variant="danger" onClick={() => setDeciding({ shop: s, action: 'suspend' })}>
                        Suspend
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
          title={deciding.action === 'reject' ? `Turn down ${deciding.shop.nameEn ?? ''}` : `Suspend ${deciding.shop.nameEn ?? ''}`}
          codes={deciding.action === 'reject' ? REASON_CODES.marketShopReject : REASON_CODES.marketShopSuspend}
          confirm={deciding.action === 'reject' ? 'Turn down' : 'Suspend'}
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

/** The market's settings: review, limits, days, the reports that hide. */
function Settings() {
  const toast = useToast();
  const settings = useQuery({ queryKey: [...KEY, 'settings'], queryFn: () => unwrap(api.GET('/api/v1/market/settings')) });
  const [form, setForm] = useState({ requiresReview: true, maxLivePerAccount: '10', expiryDays: '30', reportHideThreshold: '3' });
  useEffect(() => {
    if (settings.data)
      setForm({
        requiresReview: settings.data.requiresReview,
        maxLivePerAccount: String(settings.data.maxLivePerAccount),
        expiryDays: String(settings.data.expiryDays),
        reportHideThreshold: String(settings.data.reportHideThreshold),
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
          },
        }),
      ),
    { invalidate: [KEY], onDone: () => toast.show('Settings saved.') },
  );
  const number = (key: 'maxLivePerAccount' | 'expiryDays' | 'reportHideThreshold', text: string, hint: string) => (
    <Field label={text} hint={hint} error={fieldError(save.error, key)}>
      {(p) => <Input {...p} inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </Field>
  );
  return (
    <Card>
      <CardHeader title="Market settings" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label="Review" hint="A new or changed listing waits for a handler before it shows.">
              {(p) => (
                <Select {...p} value={form.requiresReview ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, requiresReview: e.target.value === 'yes' })}>
                  <option value="yes">Review every listing</option>
                  <option value="no">Listings go live at once</option>
                </Select>
              )}
            </Field>
            {number('maxLivePerAccount', 'Listings a resident may have open', '1 to 50.')}
            {number('expiryDays', 'Days a listing stays on the market', '1 to 180.')}
            {number('reportHideThreshold', 'Units whose reports take a listing off for review', '1 to 20.')}
            <div>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                Save
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
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('review');
  if (ready && !can('market.handle'))
    return (
      <>
        <PageHeader title="Market" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Market" description="What residents sell, give, want or offer, their shops, and what was reported." />
      <div className="stack">
        <Segmented label="Section" value={tab} onChange={setTab} options={TABS} />
        {tab === 'review' ? <Review /> : tab === 'reports' ? <Reports /> : tab === 'shops' ? <Shops /> : <Settings />}
      </div>
    </>
  );
}
