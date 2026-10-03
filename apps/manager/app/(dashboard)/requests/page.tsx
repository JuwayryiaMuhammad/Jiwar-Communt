'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
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
  useToast,
} from '@jiwar/ui';
import { Copy, Link2, Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys, type PendingMember, type Registration, type RegistrationLink } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['registrations', 'household', 'links'] as const;
type Tab = (typeof TABS)[number];

const CONFLICT_TEXT: Record<string, string> = {
  unit_not_found: 'Unit code not found',
  unit_has_primary: 'Unit already has a primary resident',
  unit_has_residing_occupants: 'Others already live in the unit',
  phone_in_use: 'Phone in use',
  email_in_use: 'Email in use',
  same_person_existing_account: 'Already has an account',
  duplicate_pending_for_unit: 'Another request for this unit',
};

function ApproveRegistration({ registration, onClose }: { registration: Registration | null; onClose: () => void }) {
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
        toast.show(`${r.fullName} is now a resident.`);
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
      title={`Approve ${registration?.fullName ?? ''}?`}
      description={
        registration
          ? `Creates their account and a ${registration.occupancyType} occupancy in unit ${registration.unitCode}.`
          : undefined
      }
      onSubmit={() => registration && approve.mutate(registration)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={approve.isPending} disabled={needsUnit && !unitId}>
            Approve
          </Button>
        </>
      }
    >
      <div className="form">
        {registration?.conflicts.length ? (
          <Alert tone="warn">
            {registration.conflicts.map((c) => CONFLICT_TEXT[c] ?? humanize(c)).join(' · ')}
          </Alert>
        ) : null}
        {needsUnit ? (
          <Field label="Unit" hint={`They typed “${registration?.unitCode}”, which matches no unit.`}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        ) : null}
        {existing ? (
          <Checkbox
            label="Link the occupancy to their existing account instead of creating a new one"
            checked={link}
            onChange={(e) => setLink(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

function Registrations() {
  const toast = useToast();
  const list = useCursorList(keys.registrations, (c) => fetchers.registrations(c));
  const [approving, setApproving] = useState<Registration | null>(null);
  const [rejecting, setRejecting] = useState<Registration | null>(null);
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
        toast.show(`${v.r.fullName}'s request was rejected and they were emailed.`);
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
          empty="No registration is waiting"
          emptyHint="People who sign up through a registration link appear here."
          columns={[
            {
              key: 'name',
              header: 'Person',
              cell: (r) => (
                <div>
                  <div className="table__primary">{r.fullName}</div>
                  <div className="list__meta">
                    {r.email} · <span className="t-num">{r.phone}</span>
                  </div>
                </div>
              ),
            },
            {
              key: 'unit',
              header: 'Unit',
              cell: (r) => (
                <div>
                  <div className="table__primary">{r.unitCode}</div>
                  <div className="list__meta">
                    {humanize(r.occupancyType)}
                    {r.resides ? ', lives there' : ', does not live there'}
                  </div>
                </div>
              ),
            },
            {
              key: 'conflicts',
              header: 'Checks',
              cell: (r) =>
                r.conflicts.length ? (
                  <span className="chip-list">
                    {r.conflicts.map((c) => (
                      <Badge key={c} tone="terracotta">
                        {CONFLICT_TEXT[c] ?? humanize(c)}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <Badge tone="green">No conflicts</Badge>
                ),
            },
            { key: 'when', header: 'Requested', cell: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
            {
              key: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (r) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => setRejecting(r)}>
                    Reject
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => setApproving(r)}>
                    Approve
                  </Button>
                </span>
              ),
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <ApproveRegistration registration={approving} onClose={() => setApproving(null)} />
      <ReasonDialog
        open={rejecting !== null}
        onClose={() => {
          setRejecting(null);
          reject.reset();
        }}
        title={`Reject ${rejecting?.fullName ?? ''}?`}
        description="They are emailed the message below. Their data is removed."
        codes={REASON_CODES.registrationReject}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reason) => rejecting && reject.mutate({ r: rejecting, ...reason })}
      />
    </Card>
  );
}

function Household() {
  const toast = useToast();
  const list = useCursorList(keys.household, (c) => fetchers.household(c));
  const [rejecting, setRejecting] = useState<PendingMember | null>(null);
  const approve = useAction(
    (m: PendingMember) =>
      unwrap(api.POST('/api/v1/household/members/{id}/approve', { params: { path: { id: m.memberId } } })),
    {
      invalidate: [keys.household],
      onDone: (_, m) => toast.show(`${m.fullName ?? 'Member'} joined unit ${m.unitCode}.`),
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
        toast.show('Request rejected.');
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
          empty="No household request is waiting"
          emptyHint="When the compound requires approval, family members added by residents wait here."
          columns={[
            {
              key: 'name',
              header: 'Member',
              cell: (m) => <span className="table__primary">{m.fullName ?? 'Invited member'}</span>,
            },
            { key: 'relation', header: 'Relation', cell: (m) => humanize(m.relation) },
            { key: 'unit', header: 'Unit', cell: (m) => m.unitCode },
            { key: 'when', header: 'Requested', cell: (m) => <span title={formatDateTime(m.requestedAt)}>{relativeTime(m.requestedAt)}</span> },
            {
              key: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (m) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => setRejecting(m)}>
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={approve.isPending && approve.variables?.memberId === m.memberId}
                    onClick={() => approve.mutate(m)}
                  >
                    Approve
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
        title="Reject this household member?"
        description={rejecting ? `Unit ${rejecting.unitCode}. The unit's primary resident is told.` : undefined}
        codes={REASON_CODES.memberRejection}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reason) => rejecting && reject.mutate({ m: rejecting, ...reason })}
      />
    </Card>
  );
}

function Links() {
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
        toast.show('Link revoked. It stops working immediately.');
        setRevoking(null);
      },
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          A link lets people ask to register as residents. With no live link, self-registration is off.
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} loading={create.isPending} onClick={() => create.mutate(undefined)}>
          New link
        </Button>
      </div>
      <ErrorAlert error={create.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<RegistrationLink>
            rows={list.rows}
            rowKey={(l) => l.id}
            empty="No registration links"
            columns={[
              {
                key: 'id',
                header: 'Link',
                cell: (l) => (
                  <span className="row">
                    <Link2 size={16} aria-hidden />
                    <span className="t-mono">{l.id.slice(0, 8)}</span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (l) => <StatusBadge status={l.revokedAt ? 'revoked' : 'active'} /> },
              { key: 'created', header: 'Created', cell: (l) => formatDateTime(l.createdAt) },
              { key: 'revoked', header: 'Revoked', cell: (l) => (l.revokedAt ? formatDateTime(l.revokedAt) : '—') },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (l) =>
                  l.revokedAt ? null : (
                    <Button size="sm" onClick={() => setRevoking(l)}>
                      Revoke
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
        title="Registration link created"
        description="This token is shown once. Only its hash is stored."
        footer={
          <>
            <Button
              icon={<Copy aria-hidden />}
              onClick={() => {
                if (created) void navigator.clipboard.writeText(created).then(() => toast.show('Copied.'));
              }}
            >
              Copy
            </Button>
            <Button variant="primary" onClick={() => setCreated(null)}>
              Done
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
        title="Revoke this link?"
        description="Anyone holding it can no longer start a registration. Requests already sent stay in the queue."
        confirmLabel="Revoke"
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </>
  );
}

function RequestsView() {
  const [tab, setTab] = useTab(TABS, 'registrations');
  return (
    <>
      <PageHeader
        title="Requests"
        description="People waiting to join the compound or a household."
        actions={
          <Segmented<Tab>
            label="Request type"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'registrations', label: 'Registrations' },
              { value: 'household', label: 'Household' },
              { value: 'links', label: 'Links' },
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
