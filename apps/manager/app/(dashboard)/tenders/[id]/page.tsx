'use client';

import { fieldError, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, ConfirmDialog, DataTable, Dialog, Field, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useNow } from '@/lib/use-now';
import { fetchers, keys, type Tender } from '@/lib/queries';

type Bid = Tender['bids'][number];
type Invitation = Tender['invitations'][number];

/** Invitations and documents change while a draft or taking bids (ADR 0088). */
const EDITABLE: readonly Tender['status'][] = ['draft', 'open'];

/** A bid link comes back once: shown here until the page is left. */
function ShownLink({ url, expiresAt, onDismiss }: { url: string; expiresAt: string; onDismiss: () => void }) {
  return (
    <div className="stack stack--sm">
      <p className="hint">
        Send this link now; it is not shown again. It opens until {formatDateTime(expiresAt)}.
      </p>
      <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="The bid link" />
      <span className="row" style={{ gap: 8 }}>
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(url)}>
          Copy
        </Button>
        <Button size="sm" onClick={onDismiss}>
          Done
        </Button>
      </span>
    </div>
  );
}

/** The deadline, later only, before it passes. */
function DeadlineDialog({ tender, open, onClose }: { tender: Tender; open: boolean; onClose: () => void }) {
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
        toast.show('The deadline moved; the invitees see the new one.');
        setAt('');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move the deadline"
      description={`Now ${formatDateTime(tender.bidsDueAt)}. Later only, and only before it passes.`}
      onSubmit={() => move.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={move.isPending} disabled={!at}>
            Move it
          </Button>
        </>
      }
    >
      <Field label="Bids until" hint="At most a year ahead." error={fieldError(move.error, 'bidsDueAt')}>
        {(p) => <Input {...p} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
      </Field>
      <ErrorAlert error={move.error} />
    </Dialog>
  );
}

/** The award: the contract is signed with the bid's vendor. */
function AwardDialog({ tender, bid, onClose }: { tender: Tender; bid: Bid | null; onClose: () => void }) {
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
      onDone: (t) => {
        toast.show(`Awarded: contract ${t.contractCode ?? ''} signed.`);
        close();
      },
    },
  );
  return (
    <Dialog
      open={bid !== null}
      onClose={close}
      title={`Award to ${bid?.bidder ?? 'this bid'}`}
      description={bid ? `${bid.amount ?? '—'} EGP. The contract (${humanize(tender.contractKind)}) is signed with the bid’s vendor.` : undefined}
      onSubmit={() => award.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={award.isPending} disabled={!code.trim() || !startsOn || !endsOn}>
            Award and sign
          </Button>
        </>
      }
    >
      <Field label="The contract’s code" hint="Unique in the compound: letters, digits, . _ -" error={fieldError(award.error, 'code')}>
        {(p) => <Input {...p} value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />}
      </Field>
      <div className="form__row">
        <Field label="Starts on" error={fieldError(award.error, 'startsOn')}>
          {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
        </Field>
        <Field label="Ends on" hint="Its last day." error={fieldError(award.error, 'endsOn')}>
          {(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
        </Field>
      </div>
      {can('governance.approvals') ? (
        <Field
          label="The board’s approval"
          hint="Needed above your limit: an approved major contract of at least the bid’s amount."
          error={fieldError(award.error, 'approvalRequestId')}
        >
          {(p) => (
            <Select {...p} value={approvalRequestId} onChange={(e) => setApprovalRequestId(e.target.value)}>
              <option value="">None</option>
              {(approvals.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.reference} · {a.cost ?? '—'} EGP
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <p className="hint">Above your limit, the award needs the board’s approved major contract: ask whoever raises board matters.</p>
      )}
      <ErrorAlert error={award.error} />
    </Dialog>
  );
}

/** Documents: read by every invitee; added and removed while it is editable. */
function Documents({ tender, editable }: { tender: Tender; editable: boolean }) {
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
        toast.show('Document added: the invitees read it.');
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
      <CardHeader title="Documents" />
      <DataTable<Tender['documents'][number]>
        rows={tender.documents}
        rowKey={(d) => d.id}
        empty="No document"
        columns={[
          {
            key: 't',
            header: 'Document',
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
                      Remove
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      {editable ? (
        <div className="form__row">
          <Field label="Its title" hint="Name it first, then choose the file. At most 20 documents." error={fieldError(add.error, 'title')}>
            {(p) => <Input {...p} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <FileUpload
            purpose="tender_document"
            label="Add a document"
            disabled={!title.trim() || add.isPending}
            onUploaded={(fileId) => add.mutateAsync(fileId).then(() => undefined)}
          />
        </div>
      ) : null}
      <ErrorAlert error={add.error} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.title ?? ''}”?`}
        description="The invitees no longer read it."
        confirmLabel="Remove"
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
        toast.show('Invited: its contractors are told.');
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
        toast.show('A new link: the one before stopped.');
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
      <CardHeader title="Invited" />
      <DataTable<Invitation>
        rows={tender.invitations}
        rowKey={(i) => i.id}
        empty="Nobody invited yet"
        columns={[
          { key: 'n', header: 'Who', cell: (i) => i.name ?? '—' },
          { key: 'k', header: 'How', cell: (i) => (i.kind === 'link' ? 'Bid link' : 'Registered vendor') },
          {
            key: 'l',
            header: 'Link opens until',
            cell: (i) => (i.kind === 'link' && !i.revokedAt && i.linkExpiresAt ? formatDateTime(i.linkExpiresAt) : '—'),
          },
          { key: 'r', header: 'Revoked', cell: (i) => (i.revokedAt ? formatDateTime(i.revokedAt) : '—') },
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
                            New link
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => setRevoking(i)}>
                          Revoke
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
              <Field label="A registered vendor" hint="Active vendors; its contractors bid from their portal." error={fieldError(inviteVendor.error, 'vendorId')}>
                {(p) => (
                  <Select {...p} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">Choose…</option>
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
                Invite
              </Button>
            </div>
          ) : null}
          <div className="form__row">
            <Field label="A company that is not registered" hint="Its bid link is shown once." error={fieldError(inviteLink.error, 'companyName')}>
              {(p) => <Input {...p} value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />}
            </Field>
            <Field label="Its contact email (optional)" hint="For your reference; nothing is sent." error={fieldError(inviteLink.error, 'contactEmail')}>
              {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Button loading={inviteLink.isPending} disabled={company.trim().length < 2} onClick={() => inviteLink.mutate(undefined)}>
              Make a bid link
            </Button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'this invitation'}?`}
        description={
          revoking?.kind === 'link'
            ? 'Its link opens nothing any more; a bid it sent is withdrawn while bids are taken.'
            : 'Its contractors no longer see the tender; a bid it sent is withdrawn while bids are taken.'
        }
        confirmLabel="Revoke"
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
    onDone: () => toast.show('Published: bids are taken until the deadline.'),
  });
  const open = useAction(() => unwrap(api.POST('/api/v1/staff/tenders/{id}/opening', { params: { path: { id } } })), {
    invalidate,
    onDone: (t) =>
      toast.show(t.status === 'opened' ? 'Opened: the bids are unsealed.' : 'Opening begun: a second person confirms it.'),
  });
  const t = q.data;
  const manage = can('tenders.manage');
  const editable = t ? manage && EDITABLE.includes(t.status) : false;
  const takingBids = t ? t.status === 'open' && new Date(t.bidsDueAt).getTime() > now : false;
  return (
    <QueryState query={q}>
      {t ? (
        <>
          <PageHeader
            title={`${t.reference} · ${t.title}`}
            description={`${humanize(t.status)} · bids until ${formatDateTime(t.bidsDueAt)}${t.contractCode ? ` · contract ${t.contractCode}` : ''}`}
            actions={
              <>
                {t.status === 'draft' && manage ? (
                  <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate(undefined)}>
                    Publish
                  </Button>
                ) : null}
                {takingBids && manage ? <Button onClick={() => setDeadline(true)}>Move the deadline</Button> : null}
                {(t.status === 'open' || t.status === 'opening') && can('tenders.open') ? (
                  <Button variant="primary" loading={open.isPending} onClick={() => open.mutate(undefined)}>
                    {t.status === 'opening' ? 'Confirm the opening' : 'Open the bids'}
                  </Button>
                ) : null}
              </>
            }
          />
          <ErrorAlert error={publish.error ?? open.error} />
          <Documents tender={t} editable={editable} />
          <Invitations tender={t} editable={editable} />
          <Card flush>
            <CardHeader title="Bids" />
            <DataTable<Bid>
              rows={t.bids}
              rowKey={(b) => b.id}
              empty="No bid yet"
              columns={[
                { key: 'w', header: 'Bidder', cell: (b) => b.bidder ?? '—' },
                { key: 't', header: 'Sent', cell: (b) => formatDateTime(b.submittedAt) },
                { key: 'a', header: 'Amount', cell: (b) => (b.sealed ? 'Sealed' : `${b.amount} EGP`) },
                { key: 'd', header: 'Days', cell: (b) => (b.sealed || b.durationDays === null ? '—' : String(b.durationDays)) },
                { key: 'n', header: 'Terms', cell: (b) => (b.sealed ? '—' : (b.note ?? '—')) },
                {
                  key: 'o',
                  header: 'Offer',
                  cell: (b) =>
                    b.offerUrl ? (
                      <a className="table__link" href={b.offerUrl} target="_blank" rel="noopener noreferrer">
                        Read
                      </a>
                    ) : (
                      '—'
                    ),
                },
                { key: 'x', header: 'Withdrawn', cell: (b) => (b.withdrawnAt ? 'Yes' : '—') },
                ...(t.status === 'opened' && manage
                  ? [
                      {
                        key: 'aw',
                        header: '',
                        cell: (b: Bid) =>
                          b.withdrawnAt ? null : (
                            <Button size="sm" variant="primary" onClick={() => setAwarding(b)}>
                              Award
                            </Button>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
          <DeadlineDialog tender={t} open={deadline} onClose={() => setDeadline(false)} />
          <AwardDialog tender={t} bid={awarding} onClose={() => setAwarding(null)} />
        </>
      ) : null}
    </QueryState>
  );
}
