'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Group = Schema<'GroupOfferView'>;
type Offer = Schema<'PartnerOfferView'>;
const GROUPS = ['market', 'group-offers'] as const;
const OFFERS = ['market', 'partner-offers'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

/** A new group offer: terms in both languages, prices, households and the close. */
function NewGroupOffer({ onClose }: { onClose: () => void }) {
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
        toast.show('Published.');
        onClose();
      },
    },
  );
  const ready = f.titleEn.trim() && f.titleAr.trim() && f.bodyEn.trim() && f.bodyAr.trim() && MONEY.test(f.listPrice) && MONEY.test(f.groupPrice) && f.closesAt;
  return (
    <Dialog
      open
      onClose={onClose}
      title="New group offer"
      description="A price when enough households buy together. Buyers pay the partner; no money passes through Jiwar."
      onSubmit={() => ready && create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Publish
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Title (English)" error={fieldError(create.error, 'titleEn')}>
          {(p) => <Input {...p} value={f.titleEn} onChange={set('titleEn')} />}
        </Field>
        <Field label="Title (Arabic)" error={fieldError(create.error, 'titleAr')}>
          {(p) => <Input {...p} dir="rtl" value={f.titleAr} onChange={set('titleAr')} />}
        </Field>
        <Field label="What it is (English)" error={fieldError(create.error, 'bodyEn')}>
          {(p) => <Textarea {...p} rows={3} value={f.bodyEn} onChange={set('bodyEn')} />}
        </Field>
        <Field label="What it is (Arabic)" error={fieldError(create.error, 'bodyAr')}>
          {(p) => <Textarea {...p} dir="rtl" rows={3} value={f.bodyAr} onChange={set('bodyAr')} />}
        </Field>
        <Field label="List price, EGP" error={fieldError(create.error, 'listPrice')}>
          {(p) => <Input {...p} inputMode="decimal" value={f.listPrice} onChange={set('listPrice')} />}
        </Field>
        <Field label="Group price, EGP" hint="Below the list price." error={fieldError(create.error, 'groupPrice')}>
          {(p) => <Input {...p} inputMode="decimal" value={f.groupPrice} onChange={set('groupPrice')} />}
        </Field>
        <Field label="Households needed" hint="At least two." error={fieldError(create.error, 'minParticipants')}>
          {(p) => <Input {...p} inputMode="numeric" value={f.minParticipants} onChange={set('minParticipants')} />}
        </Field>
        <Field label="Interest until (optional)" hint="A non-binding count first; then it opens." error={fieldError(create.error, 'interestClosesAt')}>
          {(p) => <Input {...p} type="datetime-local" value={f.interestClosesAt} onChange={set('interestClosesAt')} />}
        </Field>
        <Field label="Closes" error={fieldError(create.error, 'closesAt')}>
          {(p) => <Input {...p} type="datetime-local" value={f.closesAt} onChange={set('closesAt')} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function GroupOffers() {
  const toast = useToast();
  const list = useQuery({ queryKey: GROUPS, queryFn: () => unwrap(api.GET('/api/v1/staff/group-offers')) });
  const open = useAction((id: string) => unwrap(api.POST('/api/v1/staff/group-offers/{id}/open', { params: { path: { id } } })), {
    invalidate: [GROUPS],
    onDone: () => toast.show('Open: those interested are told.'),
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
        toast.show('Called off: those taking part are told.');
        setCancelling(null);
      },
    },
  );
  return (
    <div className="stack">
      <div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New group offer
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Group>
            rows={list.data?.data}
            rowKey={(g) => g.id}
            empty="None yet"
            columns={[
              { key: 't', header: 'Offer', cell: (g) => g.titleEn },
              {
                key: 'p',
                header: 'Price',
                cell: (g) =>
                  g.finalPrice
                    ? `${g.finalPrice} final (group ${g.groupPrice}) EGP`
                    : `${g.groupPrice} (list ${g.listPrice}) EGP`,
              },
              { key: 'n', header: 'Households', cell: (g) => <span className="t-num">{`${g.joined} / ${g.minParticipants}`}</span> },
              { key: 'i', header: 'Interested', cell: (g) => <span className="t-num">{g.interested}</span> },
              { key: 'c', header: 'Closes', cell: (g) => formatDateTime(g.closesAt) },
              { key: 's', header: 'Status', cell: (g) => <Badge tone={g.status === 'confirmed' || g.status === 'contracted' ? 'green' : g.status === 'failed' || g.status === 'cancelled' ? 'error' : 'beige'}>{label(g.status)}</Badge> },
              {
                key: 'r',
                header: 'Re-confirm by',
                cell: (g) => (g.status === 'reconfirming' && g.reconfirmClosesAt ? formatDateTime(g.reconfirmClosesAt) : '—'),
              },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (g) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {g.status === 'interest' ? (
                      <Button size="sm" variant="primary" loading={open.isPending} onClick={() => open.mutate(g.id)}>
                        Open now
                      </Button>
                    ) : null}
                    {g.status === 'interest' || g.status === 'open' ? (
                      <Button size="sm" variant="danger" onClick={() => setCancelling(g)}>
                        Call off
                      </Button>
                    ) : null}
                    {g.status === 'confirmed' ? (
                      <Button size="sm" variant="primary" onClick={() => setContracting(g)}>
                        Record the contract
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
          title={`Call off “${cancelling.titleEn}”`}
          onSubmit={() => code && cancel.mutate(undefined)}
          footer={
            <>
              <Button onClick={() => setCancelling(null)}>Keep it</Button>
              <Button type="submit" variant="danger" loading={cancel.isPending} disabled={!code}>
                Call off
              </Button>
            </>
          }
        >
          <div className="form">
            <Field label="Why" error={fieldError(cancel.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
                  <option value="">Choose…</option>
                  {REASON_CODES.groupOfferCancel.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
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
        toast.show(higher ? 'Held for re-confirmation: the households are asked.' : 'Contracted: the households are told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`The contract of “${offer.titleEn}”`}
      description={`${offer.joined} households joined at ${offer.groupPrice} EGP.`}
      onSubmit={() => contract.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={contract.isPending}>
            {higher ? 'Ask them to re-confirm' : 'Record the contract'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Final price, EGP" error={fieldError(contract.error, 'finalPrice')}>
          {(p) => <Input {...p} inputMode="decimal" value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} />}
        </Field>
        {higher ? (
          <Field
            label="Hours to re-confirm"
            hint="Above the group price, nobody is held to it without confirming: 24 to 168 hours."
            error={fieldError(contract.error, 'reconfirmHours')}
          >
            {(p) => <Input {...p} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={contract.error} />
      </div>
    </Dialog>
  );
}

function PartnerOffers({ canPublish }: { canPublish: boolean }) {
  const toast = useToast();
  const list = useQuery({ queryKey: OFFERS, queryFn: () => unwrap(api.GET('/api/v1/staff/partner-offers')), enabled: canPublish });
  const partners = useQuery({ queryKey: ['partners', 'list'], queryFn: () => unwrap(api.GET('/api/v1/staff/partners')), enabled: canPublish });
  const withdraw = useAction((id: string) => unwrap(api.POST('/api/v1/staff/partner-offers/{id}/withdraw', { params: { path: { id } } })), {
    invalidate: [OFFERS],
    onDone: () => toast.show('Withdrawn.'),
  });
  const [f, setF] = useState({ partnerId: '', titleEn: '', titleAr: '', bodyEn: '', bodyAr: '', validFromOn: '', validToOn: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/partners/{id}/offers', {
          params: { path: { id: f.partnerId } },
          body: { titleEn: f.titleEn.trim(), titleAr: f.titleAr.trim(), bodyEn: f.bodyEn.trim(), bodyAr: f.bodyAr.trim(), validFromOn: f.validFromOn, validToOn: f.validToOn },
        }),
      ),
    { invalidate: [OFFERS], onDone: () => toast.show('Published: residents see it while in force.') },
  );
  if (!canPublish) return <ForbiddenState />;
  return (
    <div className="stack">
      <Card>
        <div className="form" style={{ padding: 16 }}>
          <Field label="Partner" error={fieldError(publish.error, 'partnerId')}>
            {(p) => (
              <Select {...p} value={f.partnerId} onChange={set('partnerId')}>
                <option value="">Choose…</option>
                {partners.data?.data.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Title (English)" error={fieldError(publish.error, 'titleEn')}>
            {(p) => <Input {...p} value={f.titleEn} onChange={set('titleEn')} />}
          </Field>
          <Field label="Title (Arabic)" error={fieldError(publish.error, 'titleAr')}>
            {(p) => <Input {...p} dir="rtl" value={f.titleAr} onChange={set('titleAr')} />}
          </Field>
          <Field label="The offer (English)" error={fieldError(publish.error, 'bodyEn')}>
            {(p) => <Textarea {...p} rows={2} value={f.bodyEn} onChange={set('bodyEn')} />}
          </Field>
          <Field label="The offer (Arabic)" error={fieldError(publish.error, 'bodyAr')}>
            {(p) => <Textarea {...p} dir="rtl" rows={2} value={f.bodyAr} onChange={set('bodyAr')} />}
          </Field>
          <Field label="From" error={fieldError(publish.error, 'validFromOn')}>
            {(p) => <Input {...p} type="date" value={f.validFromOn} onChange={set('validFromOn')} />}
          </Field>
          <Field label="Until" hint="Its last day; within a year." error={fieldError(publish.error, 'validToOn')}>
            {(p) => <Input {...p} type="date" value={f.validToOn} onChange={set('validToOn')} />}
          </Field>
          <div>
            <Button
              variant="primary"
              loading={publish.isPending}
              disabled={!f.partnerId || !f.titleEn.trim() || !f.titleAr.trim() || !f.bodyEn.trim() || !f.bodyAr.trim() || !f.validFromOn || !f.validToOn}
              onClick={() => publish.mutate(undefined)}
            >
              Publish offer
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
            empty="No offers"
            columns={[
              { key: 'p', header: 'Partner', cell: (o) => o.partnerNameEn },
              { key: 't', header: 'Offer', cell: (o) => o.titleEn },
              { key: 'd', header: 'Days', cell: (o) => `${o.validFromOn} – ${o.validToOn}` },
              { key: 's', header: 'Status', cell: (o) => <Badge tone={o.status === 'active' ? 'green' : 'beige'}>{label(o.status)}</Badge> },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (o) =>
                  o.status === 'active' ? (
                    <Button size="sm" onClick={() => withdraw.mutate(o.id)}>
                      Withdraw
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
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<'group' | 'partner'>(can('market.handle') ? 'group' : 'partner');
  if (ready && !can('market.handle') && !can('partners.manage'))
    return (
      <>
        <PageHeader title="Offers" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Offers" description="Group offers for buying together, and the partners’ offers residents see on the market." />
      <div className="stack">
        <Segmented
          label="Offers"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'group', label: 'Group offers' },
            { value: 'partner', label: 'Partner offers' },
          ]}
        />
        {tab === 'group' ? can('market.handle') ? <GroupOffers /> : <ForbiddenState /> : <PartnerOffers canPublish={can('partners.manage')} />}
      </div>
    </>
  );
}
