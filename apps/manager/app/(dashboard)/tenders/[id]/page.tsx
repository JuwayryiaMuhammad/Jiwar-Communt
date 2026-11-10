'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useNow } from '@/lib/use-now';
import { fetchers, keys, type Tender } from '@/lib/queries';
import ar from '@/messages/ar/ops-tenders';
import en from '@/messages/en/ops-tenders';

type Bid = Tender['bids'][number];
type Invitation = Tender['invitations'][number];

/** Invitations and documents change while a draft or taking bids (ADR 0088). */
const EDITABLE: readonly Tender['status'][] = ['draft', 'open'];

/** A bid link comes back once: shown here until the page is left. */
function ShownLink({ url, expiresAt, onDismiss }: { url: string; expiresAt: string; onDismiss: () => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  return (
    <div className="stack stack--sm">
      <p className="hint">{t('linkShown', { when: fmt.dateTime(expiresAt) })}</p>
      <Input readOnly dir="ltr" value={url} onFocus={(e) => e.currentTarget.select()} aria-label={t('linkLabel')} />
      <span className="row" style={{ gap: 8 }}>
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(url)}>
          {t('copy')}
        </Button>
        <Button size="sm" onClick={onDismiss}>
          {t('done')}
        </Button>
      </span>
    </div>
  );
}

/** The deadline, later only, before it passes. */
function DeadlineDialog({ tender, open, onClose }: { tender: Tender; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const [at, setAt] = useState('');
  const move = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/deadline', {
          params: { path: { id: tender.id } },
          body: { bidsDueAt: new Date(at).toISOString() },
        }),
      ),
    {
      invalidate: [keys.tender(tender.id), keys.tendersAll],
      onDone: () => {
        toast.show(t('deadlineMoved'));
        setAt('');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('moveDeadline')}
      description={t('deadlineNow', { when: fmt.dateTime(tender.bidsDueAt) })}
      onSubmit={() => move.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={move.isPending} disabled={!at}>
            {t('moveIt')}
          </Button>
        </>
      }
    >
      <Field label={t('bidsUntil')} hint={t('bidsUntilHint')} error={fieldError(move.error, 'bidsDueAt')}>
        {(p) => <Input {...p} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
      </Field>
      <ErrorAlert error={move.error} />
    </Dialog>
  );
}

/** The award: the contract is signed with the bid's vendor. */
function AwardDialog({ tender, bid, onClose }: { tender: Tender; bid: Bid | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const [code, setCode] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [approvalRequestId, setApprovalRequestId] = useState('');
  const approvals = useQuery({
    queryKey: keys.majorContractApprovals,
    queryFn: () => fetchers.majorContractApprovals(),
    enabled: bid !== null && can('governance.approvals'),
  });
  const close = () => {
    setCode('');
    setStartsOn('');
    setEndsOn('');
    setApprovalRequestId('');
    onClose();
  };
  const award = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/award', {
          params: { path: { id: tender.id } },
          body: {
            bidId: bid!.id,
            code: code.trim(),
            startsOn,
            endsOn,
            ...(approvalRequestId ? { approvalRequestId } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.tender(tender.id), keys.tendersAll, keys.contractsAll],
      onDone: (x) => {
        toast.show(t('awarded', { code: x.contractCode ?? '' }));
        close();
      },
    },
  );
  return (
    <Dialog
      open={bid !== null}
      onClose={close}
      title={bid?.bidder ? t('awardTo', { bidder: bid.bidder }) : t('awardToBid')}
      description={bid ? t('awardDescription', { amount: fmt.money(bid.amount), kind: label(tender.contractKind) }) : undefined}
      onSubmit={() => award.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={award.isPending} disabled={!code.trim() || !startsOn || !endsOn}>
            {t('awardAndSign')}
          </Button>
        </>
      }
    >
      <Field label={t('contractCode')} hint={t('contractCodeHint')} error={fieldError(award.error, 'code')}>
        {(p) => <Input {...p} dir="ltr" value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />}
      </Field>
      <div className="form__row">
        <Field label={t('startsOn')} error={fieldError(award.error, 'startsOn')}>
          {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
        </Field>
        <Field label={t('endsOn')} hint={t('endsOnHint')} error={fieldError(award.error, 'endsOn')}>
          {(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
        </Field>
      </div>
      {can('governance.approvals') ? (
        <Field label={t('boardApproval')} hint={t('boardApprovalHint')} error={fieldError(award.error, 'approvalRequestId')}>
          {(p) => (
            <Select {...p} value={approvalRequestId} onChange={(e) => setApprovalRequestId(e.target.value)}>
              <option value="">{t('none')}</option>
              {(approvals.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {t('approvalOption', { reference: a.reference, cost: fmt.money(a.cost) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <p className="hint">{t('aboveLimit')}</p>
      )}
      <ErrorAlert error={award.error} />
    </Dialog>
  );
}

/** Documents: read by every invitee; added and removed while it is editable. */
function Documents({ tender, editable }: { tender: Tender; editable: boolean }) {
  const t = useT(en, ar);
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [removing, setRemoving] = useState<Tender['documents'][number] | null>(null);
  const invalidate = [keys.tender(tender.id)];
  const add = useAction(
    (fileId: string) =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/documents', {
          params: { path: { id: tender.id } },
          body: { fileId, title: title.trim() },
        }),
      ),
    {
      invalidate,
      onDone: () => {
        setTitle('');
        toast.show(t('documentAdded'));
      },
    },
  );
  const remove = useAction(
    (documentId: string) =>
      unwrap(
        api.DELETE('/api/v1/staff/tenders/{id}/documents/{documentId}', {
          params: { path: { id: tender.id, documentId } },
        }),
      ),
    { invalidate, onDone: () => setRemoving(null) },
  );
  return (
    <Card>
      <CardHeader title={t('documents')} />
      <DataTable<Tender['documents'][number]>
        rows={tender.documents}
        rowKey={(d) => d.id}
        empty={t('noDocument')}
        columns={[
          {
            key: 't',
            header: t('col.document'),
            cell: (d) =>
              d.fileUrl ? (
                <a className="table__link" href={d.fileUrl} target="_blank" rel="noopener noreferrer">
                  {d.title}
                </a>
              ) : (
                d.title
              ),
          },
          ...(editable
            ? [
                {
                  key: 'x',
                  header: '',
                  cell: (d: Tender['documents'][number]) => (
                    <Button size="sm" onClick={() => setRemoving(d)}>
                      {t('remove')}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {editable ? (
        <div className="form__row">
          <Field label={t('docTitle')} hint={t('docTitleHint')} error={fieldError(add.error, 'title')}>
            {(p) => <Input {...p} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <FileUpload
            purpose="tender_document"
            label={t('addDocument')}
            disabled={!title.trim() || add.isPending}
            onUploaded={(fileId) => add.mutateAsync(fileId).then(() => undefined)}
          />
        </div>
      ) : null}
      <ErrorAlert error={add.error} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('removeTitle', { title: removing?.title ?? '' })}
        description={t('removeDescription')}
        confirmLabel={t('remove')}
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Card>
  );
}

/** Who is invited: a registered vendor, or a company by its bid link. */
function Invitations({ tender, editable }: { tender: Tender; editable: boolean }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { can } = usePermissions();
  const toast = useToast();
  const readsVendors = ['vendors.manage', 'assets.manage', 'finance.budget', 'purchases.request', 'purchases.approve'].some((p) =>
    can(p as Parameters<typeof can>[0]),
  );
  const vendors = useQuery({
    queryKey: keys.vendors({ status: 'active' }),
    queryFn: () => fetchers.vendors({ status: 'active' }, undefined, 100),
    enabled: editable && readsVendors,
  });
  const [vendorId, setVendorId] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [shown, setShown] = useState<{ url: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const invalidate = [keys.tender(tender.id)];
  const invited = new Set(tender.invitations.filter((i) => !i.revokedAt && i.vendorId).map((i) => i.vendorId));
  const inviteVendor = useAction(
    () => unwrap(api.POST('/api/v1/staff/tenders/{id}/invitations', { params: { path: { id: tender.id } }, body: { vendorId } })),
    {
      invalidate,
      onDone: () => {
        setVendorId('');
        toast.show(t('invitedToast'));
      },
    },
  );
  const inviteLink = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/invitations', {
          params: { path: { id: tender.id } },
          body: { companyName: company.trim(), ...(email.trim() ? { contactEmail: email.trim() } : {}) },
        }),
      ),
    {
      invalidate,
      onDone: (r) => {
        if ('url' in r && typeof r.url === 'string') setShown({ url: r.url, expiresAt: String(r.expiresAt) });
        setCompany('');
        setEmail('');
      },
    },
  );
  const rotate = useAction(
    (invitationId: string) =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/invitations/{invitationId}/link', {
          params: { path: { id: tender.id, invitationId } },
        }),
      ),
    {
      invalidate,
      onDone: (r) => {
        setShown({ url: r.url, expiresAt: r.expiresAt });
        toast.show(t('newLinkToast'));
      },
    },
  );
  const revoke = useAction(
    (invitationId: string) =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/invitations/{invitationId}/revoke', {
          params: { path: { id: tender.id, invitationId } },
        }),
      ),
    { invalidate, onDone: () => setRevoking(null) },
  );
  return (
    <Card>
      <CardHeader title={t('invited')} />
      <DataTable<Invitation>
        rows={tender.invitations}
        rowKey={(i) => i.id}
        empty={t('noInvitation')}
        columns={[
          { key: 'n', header: t('col.who'), cell: (i) => i.name ?? '—' },
          { key: 'k', header: t('col.how'), cell: (i) => (i.kind === 'link' ? t('how.link') : t('how.vendor')) },
          {
            key: 'l',
            header: t('col.linkUntil'),
            cell: (i) => (i.kind === 'link' && !i.revokedAt && i.linkExpiresAt ? fmt.dateTime(i.linkExpiresAt) : '—'),
          },
          { key: 'r', header: t('col.revoked'), cell: (i) => (i.revokedAt ? fmt.dateTime(i.revokedAt) : '—') },
          ...(editable
            ? [
                {
                  key: 'a',
                  header: '',
                  cell: (i: Invitation) =>
                    i.revokedAt ? null : (
                      <span className="row" style={{ gap: 8 }}>
                        {i.kind === 'link' ? (
                          <Button size="sm" loading={rotate.isPending && rotate.variables === i.id} onClick={() => rotate.mutate(i.id)}>
                            {t('newLink')}
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => setRevoking(i)}>
                          {t('revoke')}
                        </Button>
                      </span>
                    ),
                },
              ]
            : []),
        ]}
      />
      {shown ? <ShownLink url={shown.url} expiresAt={shown.expiresAt} onDismiss={() => setShown(null)} /> : null}
      <ErrorAlert error={inviteVendor.error ?? inviteLink.error ?? rotate.error} />
      {editable ? (
        <>
          {readsVendors ? (
            <div className="form__row">
              <Field label={t('registeredVendor')} hint={t('registeredVendorHint')} error={fieldError(inviteVendor.error, 'vendorId')}>
                {(p) => (
                  <Select {...p} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">{t('choose')}</option>
                    {(vendors.data?.data ?? [])
                      .filter((v) => !invited.has(v.id))
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.reference} · {v.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Button loading={inviteVendor.isPending} disabled={!vendorId} onClick={() => inviteVendor.mutate(undefined)}>
                {t('invite')}
              </Button>
            </div>
          ) : null}
          <div className="form__row">
            <Field label={t('company')} hint={t('companyHint')} error={fieldError(inviteLink.error, 'companyName')}>
              {(p) => <Input {...p} value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />}
            </Field>
            <Field label={t('contactEmail')} hint={t('contactEmailHint')} error={fieldError(inviteLink.error, 'contactEmail')}>
              {(p) => <Input {...p} type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Button loading={inviteLink.isPending} disabled={company.trim().length < 2} onClick={() => inviteLink.mutate(undefined)}>
              {t('makeLink')}
            </Button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking?.name ? t('revokeTitle', { name: revoking.name }) : t('revokeThis')}
        description={revoking?.kind === 'link' ? t('revokeLink') : t('revokeVendor')}
        confirmLabel={t('revoke')}
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}

/**
 * One tender (ADR 0088): its documents, its invitations and bid links (a
 * link is shown once; a new one stops the old), the bids — who and when,
 * sealed until opened — the deadline moved later, the two-person opening
 * and the award, which signs the contract.
 */
export default function TenderPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: keys.tender(id), queryFn: () => fetchers.tender(id) });
  const [deadline, setDeadline] = useState(false);
  const [awarding, setAwarding] = useState<Bid | null>(null);
  const now = useNow(30_000);
  const invalidate = [keys.tender(id), keys.tendersAll];
  const publish = useAction(() => unwrap(api.POST('/api/v1/staff/tenders/{id}/publish', { params: { path: { id } } })), {
    invalidate,
    onDone: () => toast.show(t('published')),
  });
  const open = useAction(() => unwrap(api.POST('/api/v1/staff/tenders/{id}/opening', { params: { path: { id } } })), {
    invalidate,
    onDone: (x) => toast.show(x.status === 'opened' ? t('opened') : t('openingBegun')),
  });
  const tender = q.data;
  const manage = can('tenders.manage');
  const editable = tender ? manage && EDITABLE.includes(tender.status) : false;
  const takingBids = tender ? tender.status === 'open' && new Date(tender.bidsDueAt).getTime() > now : false;
  return (
    <QueryState query={q}>
      {tender ? (
        <>
          <PageHeader
            title={`${tender.reference} · ${tender.title}`}
            description={
              tender.contractCode
                ? t('summaryContract', { status: t(`status.${tender.status}`), when: fmt.dateTime(tender.bidsDueAt), code: tender.contractCode })
                : t('summary', { status: t(`status.${tender.status}`), when: fmt.dateTime(tender.bidsDueAt) })
            }
            actions={
              <>
                {tender.status === 'draft' && manage ? (
                  <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate(undefined)}>
                    {t('publish')}
                  </Button>
                ) : null}
                {takingBids && manage ? <Button onClick={() => setDeadline(true)}>{t('moveDeadline')}</Button> : null}
                {(tender.status === 'open' || tender.status === 'opening') && can('tenders.open') ? (
                  <Button variant="primary" loading={open.isPending} onClick={() => open.mutate(undefined)}>
                    {tender.status === 'opening' ? t('confirmOpening') : t('openBids')}
                  </Button>
                ) : null}
              </>
            }
          />
          <ErrorAlert error={publish.error ?? open.error} />
          <Documents tender={tender} editable={editable} />
          <Invitations tender={tender} editable={editable} />
          <Card flush>
            <CardHeader title={t('bids')} />
            <DataTable<Bid>
              rows={tender.bids}
              rowKey={(b) => b.id}
              empty={t('noBid')}
              columns={[
                { key: 'w', header: t('col.bidder'), cell: (b) => b.bidder ?? '—' },
                { key: 't', header: t('col.sent'), cell: (b) => fmt.dateTime(b.submittedAt) },
                { key: 'a', header: t('col.amount'), cell: (b) => (b.sealed ? t('sealed') : fmt.money(b.amount)) },
                { key: 'd', header: t('col.days'), cell: (b) => (b.sealed || b.durationDays === null ? '—' : fmt.number(b.durationDays)) },
                { key: 'n', header: t('col.terms'), cell: (b) => (b.sealed ? '—' : (b.note ?? '—')) },
                {
                  key: 'o',
                  header: t('col.offer'),
                  // Sealed as the amount: none before the opening (ADR 0088).
                  cell: (b) =>
                    b.offerUrl || b.documents.length ? (
                      <span className="stack stack--sm">
                        {b.offerUrl ? (
                          <a className="table__link" href={b.offerUrl} target="_blank" rel="noopener noreferrer">
                            {t('theOffer')}
                          </a>
                        ) : null}
                        {b.documents.map((d) =>
                          d.fileUrl ? (
                            <a key={d.id} className="table__link" href={d.fileUrl} target="_blank" rel="noopener noreferrer">
                              {d.title}
                            </a>
                          ) : (
                            <span key={d.id}>{d.title}</span>
                          ),
                        )}
                      </span>
                    ) : b.sealed ? (
                      t('sealed')
                    ) : (
                      '—'
                    ),
                },
                { key: 'x', header: t('col.withdrawn'), cell: (b) => (b.withdrawnAt ? t('yes') : '—') },
                ...(tender.status === 'opened' && manage
                  ? [
                      {
                        key: 'aw',
                        header: '',
                        cell: (b: Bid) =>
                          b.withdrawnAt ? null : (
                            <Button size="sm" variant="primary" onClick={() => setAwarding(b)}>
                              {t('award')}
                            </Button>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
          <DeadlineDialog tender={tender} open={deadline} onClose={() => setDeadline(false)} />
          <AwardDialog tender={tender} bid={awarding} onClose={() => setAwarding(null)} />
        </>
      ) : null}
    </QueryState>
  );
}
