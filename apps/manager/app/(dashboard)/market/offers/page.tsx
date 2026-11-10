'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/market-offers';
import en from '@/messages/en/market-offers';

type Group = Schema<'GroupOfferView'>;
type Offer = Schema<'PartnerOfferView'>;
const GROUPS = ['market', 'group-offers'] as const;
const OFFERS = ['market', 'partner-offers'] as const;
/** A group offer's "interest" is a head count, not money. */
const WORDS = { en: { interest: en['code.interest'] }, ar: { interest: ar['code.interest'] } };
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

/** A new group offer: terms in both languages, prices, households and the close. */
function NewGroupOffer({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [f, setF] = useState({ titleEn: '', titleAr: '', bodyEn: '', bodyAr: '', listPrice: '', groupPrice: '', minParticipants: '5', interestClosesAt: '', closesAt: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/group-offers', {
          body: {
            titleEn: f.titleEn.trim(),
            titleAr: f.titleAr.trim(),
            bodyEn: f.bodyEn.trim(),
            bodyAr: f.bodyAr.trim(),
            listPrice: f.listPrice.trim(),
            groupPrice: f.groupPrice.trim(),
            minParticipants: Number(f.minParticipants),
            ...(f.interestClosesAt ? { interestClosesAt: new Date(f.interestClosesAt).toISOString() } : {}),
            closesAt: new Date(f.closesAt).toISOString(),
          },
        }),
      ),
    {
      invalidate: [GROUPS],
      onDone: () => {
        toast.show(t('new.published'));
        onClose();
      },
    },
  );
  const ready = f.titleEn.trim() && f.titleAr.trim() && f.bodyEn.trim() && f.bodyAr.trim() && MONEY.test(f.listPrice) && MONEY.test(f.groupPrice) && f.closesAt;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('new.title')}
      description={t('new.description')}
      onSubmit={() => ready && create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            {t('new.publish')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('new.titleEn')} error={fieldError(create.error, 'titleEn')}>
          {(p) => <Input {...p} value={f.titleEn} onChange={set('titleEn')} />}
        </Field>
        <Field label={t('new.titleAr')} error={fieldError(create.error, 'titleAr')}>
          {(p) => <Input {...p} dir="rtl" value={f.titleAr} onChange={set('titleAr')} />}
        </Field>
        <Field label={t('new.bodyEn')} error={fieldError(create.error, 'bodyEn')}>
          {(p) => <Textarea {...p} rows={3} value={f.bodyEn} onChange={set('bodyEn')} />}
        </Field>
        <Field label={t('new.bodyAr')} error={fieldError(create.error, 'bodyAr')}>
          {(p) => <Textarea {...p} dir="rtl" rows={3} value={f.bodyAr} onChange={set('bodyAr')} />}
        </Field>
        <Field label={t('new.listPrice')} error={fieldError(create.error, 'listPrice')}>
          {(p) => <Input {...p} className="ltr" inputMode="decimal" value={f.listPrice} onChange={set('listPrice')} />}
        </Field>
        <Field label={t('new.groupPrice')} hint={t('new.groupPriceHint')} error={fieldError(create.error, 'groupPrice')}>
          {(p) => <Input {...p} className="ltr" inputMode="decimal" value={f.groupPrice} onChange={set('groupPrice')} />}
        </Field>
        <Field label={t('new.households')} hint={t('new.householdsHint')} error={fieldError(create.error, 'minParticipants')}>
          {(p) => <Input {...p} className="ltr" inputMode="numeric" value={f.minParticipants} onChange={set('minParticipants')} />}
        </Field>
        <Field label={t('new.interestUntil')} hint={t('new.interestUntilHint')} error={fieldError(create.error, 'interestClosesAt')}>
          {(p) => <Input {...p} type="datetime-local" value={f.interestClosesAt} onChange={set('interestClosesAt')} />}
        </Field>
        <Field label={t('new.closes')} error={fieldError(create.error, 'closesAt')}>
          {(p) => <Input {...p} type="datetime-local" value={f.closesAt} onChange={set('closesAt')} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function GroupOffers() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel(WORDS);
  const { locale } = useLocale();
  const toast = useToast();
  const list = useQuery({ queryKey: GROUPS, queryFn: () => unwrap(api.GET('/api/v1/staff/group-offers')) });
  const open = useAction((id: string) => unwrap(api.POST('/api/v1/staff/group-offers/{id}/open', { params: { path: { id } } })), {
    invalidate: [GROUPS],
    onDone: () => toast.show(t('opened')),
  });
  const [creating, setCreating] = useState(false);
  const [contracting, setContracting] = useState<Group | null>(null);
  const [cancelling, setCancelling] = useState<Group | null>(null);
  const [code, setCode] = useState('');
  const cancel = useAction(
    () => unwrap(api.POST('/api/v1/staff/group-offers/{id}/cancel', { params: { path: { id: cancelling!.id } }, body: { reasonCode: code } })),
    {
      invalidate: [GROUPS],
      onDone: () => {
        toast.show(t('calledOff'));
        setCancelling(null);
      },
    },
  );
  return (
    <div className="stack">
      <div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('newOffer')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Group>
            rows={list.data?.data}
            rowKey={(g) => g.id}
            empty={t('none')}
            columns={[
              { key: 't', header: t('offer'), cell: (g) => (locale === 'ar' ? g.titleAr : g.titleEn) },
              {
                key: 'p',
                header: t('price'),
                cell: (g) =>
                  g.finalPrice
                    ? t('priceFinal', { final: fmt.money(g.finalPrice), group: fmt.money(g.groupPrice) })
                    : t('priceGroup', { group: fmt.money(g.groupPrice), list: fmt.money(g.listPrice) }),
              },
              { key: 'n', header: t('households'), cell: (g) => <span className="t-num">{`${fmt.number(g.joined)} / ${fmt.number(g.minParticipants)}`}</span> },
              { key: 'i', header: t('interested'), cell: (g) => <span className="t-num">{fmt.number(g.interested)}</span> },
              { key: 'c', header: t('closes'), cell: (g) => fmt.dateTime(g.closesAt) },
              { key: 's', header: c('status'), cell: (g) => <Badge tone={g.status === 'confirmed' || g.status === 'contracted' ? 'green' : g.status === 'failed' || g.status === 'cancelled' ? 'error' : 'beige'}>{label(g.status)}</Badge> },
              {
                key: 'r',
                header: t('reconfirmBy'),
                cell: (g) => (g.status === 'reconfirming' && g.reconfirmClosesAt ? fmt.dateTime(g.reconfirmClosesAt) : '—'),
              },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (g) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {g.status === 'interest' ? (
                      <Button size="sm" variant="primary" loading={open.isPending} onClick={() => open.mutate(g.id)}>
                        {t('openNow')}
                      </Button>
                    ) : null}
                    {g.status === 'interest' || g.status === 'open' ? (
                      <Button size="sm" variant="danger" onClick={() => setCancelling(g)}>
                        {t('callOff')}
                      </Button>
                    ) : null}
                    {g.status === 'confirmed' ? (
                      <Button size="sm" variant="primary" onClick={() => setContracting(g)}>
                        {t('recordContract')}
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={open.error} />
      {creating ? <NewGroupOffer onClose={() => setCreating(false)} /> : null}
      {contracting ? <ContractDialog offer={contracting} onClose={() => setContracting(null)} /> : null}
      {cancelling ? (
        <Dialog
          open
          onClose={() => setCancelling(null)}
          title={t('callOffTitle', { title: locale === 'ar' ? cancelling.titleAr : cancelling.titleEn })}
          onSubmit={() => code && cancel.mutate(undefined)}
          footer={
            <>
              <Button onClick={() => setCancelling(null)}>{t('keepIt')}</Button>
              <Button type="submit" variant="danger" loading={cancel.isPending} disabled={!code}>
                {t('callOff')}
              </Button>
            </>
          }
        >
          <div className="form">
            <Field label={t('why')} error={fieldError(cancel.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
                  <option value="">{t('choose')}</option>
                  {REASON_CODES.groupOfferCancel.map((reason) => (
                    <option key={reason} value={reason}>
                      {label(reason)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <ErrorAlert error={cancel.error} />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * A confirmed offer's contract (ADR 0083): the final price agreed with the
 * supplier. At or below the group price it is contracted at once; above
 * it, each household re-confirms within the hours given, or drops out.
 */
function ContractDialog({ offer, onClose }: { offer: Group; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const [finalPrice, setFinalPrice] = useState(offer.groupPrice);
  const [hours, setHours] = useState('72');
  const higher = Number(finalPrice) > Number(offer.groupPrice);
  const contract = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/group-offers/{id}/contract', {
          params: { path: { id: offer.id } },
          body: { finalPrice, ...(higher ? { reconfirmHours: Number(hours) } : {}) },
        }),
      ),
    {
      invalidate: [GROUPS],
      onDone: () => {
        toast.show(higher ? t('contract.heldDone') : t('contract.doneTold'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('contract.title', { title: locale === 'ar' ? offer.titleAr : offer.titleEn })}
      description={t('contract.description', { joined: offer.joined, price: fmt.money(offer.groupPrice) })}
      onSubmit={() => contract.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={contract.isPending}>
            {higher ? t('contract.reconfirm') : t('recordContract')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('contract.finalPrice')} error={fieldError(contract.error, 'finalPrice')}>
          {(p) => <Input {...p} className="ltr" inputMode="decimal" value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} />}
        </Field>
        {higher ? (
          <Field
            label={t('contract.hours')}
            hint={t('contract.hoursHint')}
            error={fieldError(contract.error, 'reconfirmHours')}
          >
            {(p) => <Input {...p} className="ltr" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={contract.error} />
      </div>
    </Dialog>
  );
}

function PartnerOffers({ canPublish }: { canPublish: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const list = useQuery({ queryKey: OFFERS, queryFn: () => unwrap(api.GET('/api/v1/staff/partner-offers')), enabled: canPublish });
  const partners = useQuery({ queryKey: ['partners', 'list'], queryFn: () => unwrap(api.GET('/api/v1/staff/partners')), enabled: canPublish });
  const withdraw = useAction((id: string) => unwrap(api.POST('/api/v1/staff/partner-offers/{id}/withdraw', { params: { path: { id } } })), {
    invalidate: [OFFERS],
    onDone: () => toast.show(t('partner.withdrawn')),
  });
  const [form, setF] = useState({ partnerId: '', titleEn: '', titleAr: '', bodyEn: '', bodyAr: '', validFromOn: '', validToOn: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setF({ ...form, [k]: e.target.value });
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/partners/{id}/offers', {
          params: { path: { id: form.partnerId } },
          body: { titleEn: form.titleEn.trim(), titleAr: form.titleAr.trim(), bodyEn: form.bodyEn.trim(), bodyAr: form.bodyAr.trim(), validFromOn: form.validFromOn, validToOn: form.validToOn },
        }),
      ),
    { invalidate: [OFFERS], onDone: () => toast.show(t('partner.published')) },
  );
  if (!canPublish) return <ForbiddenState />;
  return (
    <div className="stack">
      <Card>
        <div className="form" style={{ padding: 16 }}>
          <Field label={t('partner.partner')} error={fieldError(publish.error, 'partnerId')}>
            {(p) => (
              <Select {...p} value={form.partnerId} onChange={set('partnerId')}>
                <option value="">{t('choose')}</option>
                {partners.data?.data.map((x) => (
                  <option key={x.id} value={x.id}>
                    {locale === 'ar' ? x.nameAr : x.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('partner.titleEn')} error={fieldError(publish.error, 'titleEn')}>
            {(p) => <Input {...p} value={form.titleEn} onChange={set('titleEn')} />}
          </Field>
          <Field label={t('partner.titleAr')} error={fieldError(publish.error, 'titleAr')}>
            {(p) => <Input {...p} dir="rtl" value={form.titleAr} onChange={set('titleAr')} />}
          </Field>
          <Field label={t('partner.bodyEn')} error={fieldError(publish.error, 'bodyEn')}>
            {(p) => <Textarea {...p} rows={2} value={form.bodyEn} onChange={set('bodyEn')} />}
          </Field>
          <Field label={t('partner.bodyAr')} error={fieldError(publish.error, 'bodyAr')}>
            {(p) => <Textarea {...p} dir="rtl" rows={2} value={form.bodyAr} onChange={set('bodyAr')} />}
          </Field>
          <Field label={c('from')} error={fieldError(publish.error, 'validFromOn')}>
            {(p) => <Input {...p} type="date" value={form.validFromOn} onChange={set('validFromOn')} />}
          </Field>
          <Field label={t('partner.until')} hint={t('partner.untilHint')} error={fieldError(publish.error, 'validToOn')}>
            {(p) => <Input {...p} type="date" value={form.validToOn} onChange={set('validToOn')} />}
          </Field>
          <div>
            <Button
              variant="primary"
              loading={publish.isPending}
              disabled={!form.partnerId || !form.titleEn.trim() || !form.titleAr.trim() || !form.bodyEn.trim() || !form.bodyAr.trim() || !form.validFromOn || !form.validToOn}
              onClick={() => publish.mutate(undefined)}
            >
              {t('partner.publish')}
            </Button>
          </div>
          <ErrorAlert error={publish.error} />
        </div>
      </Card>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Offer>
            rows={list.data?.data}
            rowKey={(o) => o.id}
            empty={t('partner.empty')}
            columns={[
              { key: 'p', header: t('partner.partner'), cell: (o) => (locale === 'ar' ? o.partnerNameAr : o.partnerNameEn) },
              { key: 't', header: t('offer'), cell: (o) => (locale === 'ar' ? o.titleAr : o.titleEn) },
              { key: 'd', header: t('partner.days'), cell: (o) => `${fmt.day(o.validFromOn)} – ${fmt.day(o.validToOn)}` },
              { key: 's', header: c('status'), cell: (o) => <Badge tone={o.status === 'active' ? 'green' : 'beige'}>{label(o.status)}</Badge> },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (o) =>
                  o.status === 'active' ? (
                    <Button size="sm" onClick={() => withdraw.mutate(o.id)}>
                      {t('partner.withdraw')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={withdraw.error} />
    </div>
  );
}

/**
 * Offers (ADR 0071): group offers the market's handlers run, and the
 * partners' offers those who keep the partners publish.
 */
export default function OffersPage() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<'group' | 'partner'>(can('market.handle') ? 'group' : 'partner');
  if (ready && !can('market.handle') && !can('partners.manage'))
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
        <Segmented
          label={t('section')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'group', label: t('tab.group') },
            { value: 'partner', label: t('tab.partner') },
          ]}
        />
        {tab === 'group' ? can('market.handle') ? <GroupOffers /> : <ForbiddenState /> : <PartnerOffers canPublish={can('partners.manage')} />}
      </div>
    </>
  );
}
