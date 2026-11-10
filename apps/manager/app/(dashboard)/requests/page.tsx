'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  PageHeader,
  ReasonDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT, type Translate } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { Copy, Link2, Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys, type PendingMember, type Registration, type RegistrationLink } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/requests';
import en from '@/messages/en/requests';

const TABS = ['registrations', 'household', 'links'] as const;
type Tab = (typeof TABS)[number];

const CONFLICTS = [
  'unit_not_found',
  'unit_has_primary',
  'unit_has_residing_occupants',
  'phone_in_use',
  'email_in_use',
  'same_person_existing_account',
  'duplicate_pending_for_unit',
] as const;
const CORRECTIONS = ['document_unreadable', 'document_missing', 'document_mismatch', 'details_mismatch'] as const;
type T = Translate<typeof en>;
type Label = (code: string) => string;
const among = <V extends string>(list: readonly V[], value: string): value is V => (list as readonly string[]).includes(value);
const conflictText = (t: T, label: Label, code: string) => (among(CONFLICTS, code) ? t(`conflict.${code}`) : label(code));
const correctionText = (t: T, label: Label, code: string) => (among(CORRECTIONS, code) ? t(`correction.${code}`) : label(code));

function ApproveRegistration({ registration, onClose }: { registration: Registration | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [unitId, setUnitId] = useState('');
  const [link, setLink] = useState(false);
  const needsUnit = registration?.unitId == null;
  const existing = registration?.conflicts.includes('same_person_existing_account') ?? false;
  const approve = useAction(
    (r: Registration) =>
      unwrap(
        api.POST('/api/v1/registrations/{id}/approve', {
          params: { path: { id: r.id } },
          body: { ...(needsUnit && unitId ? { unitId } : {}), ...(existing ? { linkToExistingAccount: link } : {}) },
        }),
      ),
    {
      invalidate: [keys.registrations, keys.residents, keys.units],
      onDone: (_, r) => {
        toast.show(t('approved', { name: r.fullName }));
        close();
      },
    },
  );
  function close() {
    setUnitId('');
    setLink(false);
    approve.reset();
    onClose();
  }
  return (
    <Dialog
      open={registration !== null}
      onClose={close}
      title={t('approveTitle', { name: registration?.fullName ?? '' })}
      description={
        registration
          ? t('approveDescription', { type: label(registration.occupancyType), unit: registration.unitCode })
          : undefined
      }
      onSubmit={() => registration && approve.mutate(registration)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={approve.isPending} disabled={needsUnit && !unitId}>
            {t('approve')}
          </Button>
        </>
      }
    >
      <div className="form">
        {registration?.conflicts.length ? (
          <Alert tone="warn">
            {registration.conflicts.map((x) => conflictText(t, label, x)).join(' · ')}
          </Alert>
        ) : null}
        {needsUnit ? (
          <Field label={c('unit')} hint={t('unitHint', { code: registration?.unitCode ?? '' })}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        ) : null}
        {existing ? (
          <Checkbox
            label={t('linkExisting')}
            checked={link}
            onChange={(e) => setLink(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

/** Opens a presigned document in a new tab (no-store routes). */
const openUrl = (r: { url: string }) => window.open(r.url, '_blank', 'noopener');

function Registrations() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const list = useCursorList(keys.registrations, (c) => fetchers.registrations(c));
  // Sent back for a correction (ADR 0062): waiting for the registrant.
  const waiting = useQuery({
    queryKey: [...keys.registrations, 'needs_correction'],
    queryFn: () => unwrap(api.GET('/api/v1/registrations', { params: { query: { status: 'needs_correction', limit: 100 } } })),
  });
  const [approving, setApproving] = useState<Registration | null>(null);
  const [rejecting, setRejecting] = useState<Registration | null>(null);
  const [correcting, setCorrecting] = useState<Registration | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const openDocument = useAction(
    (v: { r: Registration; documentId: string }) =>
      unwrap(api.GET('/api/v1/registrations/{id}/documents/{documentId}', { params: { path: { id: v.r.id, documentId: v.documentId } } })),
    { onDone: openUrl },
  );
  const correct = useAction(
    (r: Registration) => unwrap(api.POST('/api/v1/registrations/{id}/request-correction', { params: { path: { id: r.id } }, body: { codes: codes as Schema<'RegistrationCorrectionDto'>['codes'] } })),
    {
      invalidate: [keys.registrations],
      onDone: (_, r) => {
        toast.show(t('askedToCorrect', { name: r.fullName }));
        setCorrecting(null);
        setCodes([]);
      },
    },
  );
  const reject = useAction(
    (v: { r: Registration; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/registrations/{id}/reject', {
          params: { path: { id: v.r.id } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: [keys.registrations],
      onDone: (_, v) => {
        toast.show(t('rejectedRegistration', { name: v.r.fullName }));
        setRejecting(null);
      },
    },
  );
  return (
    <Card flush>
      <QueryState query={list}>
        <DataTable<Registration>
          rows={list.rows}
          rowKey={(r) => r.id}
          empty={t('noRegistration')}
          emptyHint={t('noRegistrationHint')}
          columns={[
            {
              key: 'name',
              header: t('person'),
              cell: (r) => (
                <div>
                  <div className="table__primary">{r.fullName}</div>
                  <div className="list__meta">
                    <span className="ltr">{r.email}</span> · <span className="t-num ltr">{r.phone}</span>
                  </div>
                </div>
              ),
            },
            {
              key: 'unit',
              header: c('unit'),
              cell: (r) => (
                <div>
                  <div className="table__primary">{r.unitCode}</div>
                  <div className="list__meta">
                    {t(r.resides ? 'residesYes' : 'residesNo', { type: label(r.occupancyType) })}
                  </div>
                </div>
              ),
            },
            {
              key: 'conflicts',
              header: t('checks'),
              cell: (r) =>
                r.conflicts.length ? (
                  <span className="chip-list">
                    {r.conflicts.map((x) => (
                      <Badge key={x} tone="terracotta">
                        {conflictText(t, label, x)}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <Badge tone="green">{t('noConflicts')}</Badge>
                ),
            },
            {
              key: 'documents',
              header: t('proof'),
              cell: (r) =>
                r.documents.length ? (
                  <span className="chip-list">
                    {r.documents.map((d) => (
                      <Button key={d.id} size="sm" variant="text" disabled={!d.ready} onClick={() => openDocument.mutate({ r, documentId: d.id })}>
                        {label(d.kind)}
                      </Button>
                    ))}
                  </span>
                ) : (
                  <span className="t-secondary">{t('noneYet')}</span>
                ),
            },
            { key: 'when', header: t('requested'), cell: (r) => <span title={f.dateTime(r.createdAt)}>{f.relative(r.createdAt)}</span> },
            {
              key: 'actions',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (r) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => setRejecting(r)}>
                    {t('reject')}
                  </Button>
                  <Button size="sm" onClick={() => setCorrecting(r)}>
                    {t('askToCorrect')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => setApproving(r)}>
                    {t('approve')}
                  </Button>
                </span>
              ),
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <ErrorAlert error={openDocument.error} />
      {waiting.data?.data.length ? (
        <div style={{ padding: 16 }}>
          <h3 className="t-h3">{t('waitingFor')}</h3>
          <ul>
            {waiting.data.data.map((r) => (
              <li key={r.id}>
                {t('waitingLine', {
                  name: r.fullName,
                  unit: r.unitCode,
                  what: r.correctionCodes.map((x) => correctionText(t, label, x)).join(t('listSeparator')),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Dialog
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        title={t('correctTitle', { name: correcting?.fullName ?? '' })}
        description={t('correctDescription')}
        onSubmit={(e) => {
          e.preventDefault();
          if (correcting) correct.mutate(correcting);
        }}
        footer={
          <Button variant="primary" type="submit" loading={correct.isPending} disabled={!codes.length}>
            {c('send')}
          </Button>
        }
      >
        <ErrorAlert error={correct.error} />
        {REASON_CODES.registrationCorrection.map((code) => (
          <Checkbox
            key={code}
            label={correctionText(t, label, code)}
            checked={codes.includes(code)}
            onChange={(e) => setCodes(e.target.checked ? [...codes, code] : codes.filter((x) => x !== code))}
          />
        ))}
      </Dialog>
      <ApproveRegistration registration={approving} onClose={() => setApproving(null)} />
      <ReasonDialog
        open={rejecting !== null}
        onClose={() => {
          setRejecting(null);
          reject.reset();
        }}
        title={t('rejectTitle', { name: rejecting?.fullName ?? '' })}
        description={t('rejectDescription')}
        codes={REASON_CODES.registrationReject}
        confirmLabel={t('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reason) => rejecting && reject.mutate({ r: rejecting, ...reason })}
      />
    </Card>
  );
}

function Household() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const list = useCursorList(keys.household, (c) => fetchers.household(c));
  const [rejecting, setRejecting] = useState<PendingMember | null>(null);
  const openKinship = useAction(
    (v: { m: PendingMember; documentId: string }) =>
      unwrap(api.GET('/api/v1/household/members/{id}/kinship-documents/{documentId}', { params: { path: { id: v.m.memberId, documentId: v.documentId } } })),
    { onDone: openUrl },
  );
  const approve = useAction(
    (m: PendingMember) =>
      unwrap(api.POST('/api/v1/household/members/{id}/approve', { params: { path: { id: m.memberId } } })),
    {
      invalidate: [keys.household],
      onDone: (_, m) => toast.show(t('joined', { name: m.fullName ?? t('member'), unit: m.unitCode })),
    },
  );
  const reject = useAction(
    (v: { m: PendingMember; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/household/members/{id}/reject', {
          params: { path: { id: v.m.memberId } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: [keys.household],
      onDone: () => {
        toast.show(t('rejectedMember'));
        setRejecting(null);
      },
    },
  );
  return (
    <Card flush>
      {approve.error ? (
        <div style={{ padding: 16 }}>
          <ErrorAlert error={approve.error} />
        </div>
      ) : null}
      <QueryState query={list}>
        <DataTable<PendingMember>
          rows={list.rows}
          rowKey={(m) => m.memberId}
          empty={t('noHousehold')}
          emptyHint={t('noHouseholdHint')}
          columns={[
            {
              key: 'name',
              header: t('member'),
              cell: (m) => <span className="table__primary">{m.fullName ?? t('invitedMember')}</span>,
            },
            { key: 'relation', header: t('relation'), cell: (m) => label(m.relation) },
            {
              key: 'proof',
              header: t('kinshipProof'),
              cell: (m) =>
                m.kinshipDocuments.length ? (
                  <span className="chip-list">
                    {m.kinshipDocuments.map((d) => (
                      <Button key={d.id} size="sm" variant="text" onClick={() => openKinship.mutate({ m, documentId: d.id })}>
                        {label(d.kind)}
                      </Button>
                    ))}
                  </span>
                ) : (
                  <span className="t-secondary">{t('none')}</span>
                ),
            },
            { key: 'unit', header: c('unit'), cell: (m) => m.unitCode },
            { key: 'when', header: t('requested'), cell: (m) => <span title={f.dateTime(m.requestedAt)}>{f.relative(m.requestedAt)}</span> },
            {
              key: 'actions',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (m) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => setRejecting(m)}>
                    {t('reject')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={approve.isPending && approve.variables?.memberId === m.memberId}
                    onClick={() => approve.mutate(m)}
                  >
                    {t('approve')}
                  </Button>
                </span>
              ),
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <ReasonDialog
        open={rejecting !== null}
        onClose={() => {
          setRejecting(null);
          reject.reset();
        }}
        title={t('rejectMemberTitle')}
        description={rejecting ? t('rejectMemberDescription', { unit: rejecting.unitCode }) : undefined}
        codes={REASON_CODES.memberRejection}
        confirmLabel={t('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reason) => rejecting && reject.mutate({ m: rejecting, ...reason })}
      />
    </Card>
  );
}

function Links() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const list = useCursorList(keys.registrationLinks, (c) => fetchers.registrationLinks(c));
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<RegistrationLink | null>(null);
  const create = useAction(() => unwrap(api.POST('/api/v1/registration-links')), {
    invalidate: [keys.registrationLinks],
    onDone: (link) => setCreated(link.token),
  });
  const revoke = useAction(
    (l: RegistrationLink) =>
      unwrap(api.POST('/api/v1/registration-links/{id}/revoke', { params: { path: { id: l.id } } })),
    {
      invalidate: [keys.registrationLinks],
      onDone: () => {
        toast.show(t('linkRevoked'));
        setRevoking(null);
      },
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          {t('linksNote')}
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} loading={create.isPending} onClick={() => create.mutate(undefined)}>
          {t('newLink')}
        </Button>
      </div>
      <ErrorAlert error={create.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<RegistrationLink>
            rows={list.rows}
            rowKey={(l) => l.id}
            empty={t('noLinks')}
            columns={[
              {
                key: 'id',
                header: t('link'),
                cell: (l) => (
                  <span className="row">
                    <Link2 size={16} aria-hidden />
                    <span className="t-mono ltr">{l.id.slice(0, 8)}</span>
                  </span>
                ),
              },
              { key: 'status', header: c('status'), cell: (l) => <StatusBadge status={l.revokedAt ? 'revoked' : 'active'} /> },
              { key: 'created', header: c('created'), cell: (l) => f.dateTime(l.createdAt) },
              { key: 'revoked', header: t('revokedAt'), cell: (l) => (l.revokedAt ? f.dateTime(l.revokedAt) : '—') },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (l) =>
                  l.revokedAt ? null : (
                    <Button size="sm" onClick={() => setRevoking(l)}>
                      {t('revoke')}
                    </Button>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title={t('linkCreated')}
        description={t('linkCreatedNote')}
        footer={
          <>
            <Button
              icon={<Copy aria-hidden />}
              onClick={() => {
                if (created) void navigator.clipboard.writeText(created).then(() => toast.show(t('copied')));
              }}
            >
              {t('copy')}
            </Button>
            <Button variant="primary" onClick={() => setCreated(null)}>
              {c('done')}
            </Button>
          </>
        }
      >
        <div className="code-box">{created}</div>
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title={t('revokeTitle')}
        description={t('revokeDescription')}
        confirmLabel={t('revoke')}
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </>
  );
}

function RequestsView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'registrations');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Segmented<Tab>
            label={t('requestType')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'registrations', label: t('tab.registrations') },
              { value: 'household', label: t('tab.household') },
              { value: 'links', label: t('tab.links') },
            ]}
          />
        }
      />
      {tab === 'registrations' ? <Registrations /> : tab === 'household' ? <Household /> : <Links />}
    </>
  );
}

export default function RequestsPage() {
  return (
    <Suspense>
      <RequestsView />
    </Suspense>
  );
}
