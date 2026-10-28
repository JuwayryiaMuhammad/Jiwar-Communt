'use client';

import {
  errorText,
  formatDate,
  formatDateTime,
  REASON_CODES,
  unwrap,
  type Schema,
} from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Contract = Schema<'ContractView'>;
type Doc = Schema<'UnitDocumentView'>;
type Deposit = Schema<'DepositView'>;
type Occupant = Schema<'UnitOccupantView'>;

const contractsKey = (u: string) => ['units', u, 'contracts'] as const;
const documentsKey = (u: string) => ['units', u, 'documents'] as const;
const depositsKey = (u: string) => ['units', u, 'deposits'] as const;

/**
 * A unit's papers (ADR 0062): its contracts (leases, ownership), the
 * documents the management keeps in its vault (residents' own uploads are
 * theirs alone), the deposits the management holds for its occupants, and
 * a clearance certificate when the unit owes nothing.
 */
export default function UnitPapersPage() {
  const { id: unitId } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const unit = useQuery({
    queryKey: keys.unit(unitId),
    queryFn: () => fetchers.unit(unitId),
  });
  const occupants: Occupant[] = unit.data?.occupants ?? [];
  const nameOf = (occupancyId: string) =>
    occupants.find((o) => o.occupancyId === occupancyId)?.account.fullName ??
    'A former occupant';

  return (
    <>
      <PageHeader
        title={`Papers of ${unit.data?.code ?? 'the unit'}`}
        description="Contracts, the documents the management keeps, deposits held and clearance certificates."
      />
      {can('contracts.manage') ? (
        <Contracts unitId={unitId} occupants={occupants} nameOf={nameOf} />
      ) : null}
      {can('unit_documents.manage') ? <Documents unitId={unitId} /> : null}
      {can('deposits.manage') ? (
        <Deposits unitId={unitId} occupants={occupants} nameOf={nameOf} />
      ) : null}
      {can('finance.invoice') ? <Clearance unitId={unitId} /> : null}
      {can('residents.manage') ? <Proxies unitId={unitId} /> : null}
    </>
  );
}

/**
 * The unit's proxies (ADR 0063), read only: its owners appoint and revoke
 * them from the app; a proxy acts while the unit is closed or has no primary.
 */
function Proxies({ unitId }: { unitId: string }) {
  const list = useQuery({
    queryKey: ['unit-proxies', unitId],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/proxies', {
          params: { path: { unitId } },
        }),
      ),
  });
  return (
    <Card flush>
      <CardHeader title="Proxies" />
      <QueryState query={list}>
        <DataTable<Schema<'ProxyView'>>
          rows={list.data}
          rowKey={(p) => p.id}
          empty="No proxy"
          emptyHint="An owner appoints one from the app, for a closed or vacant unit."
          columns={[
            { key: 'name', header: 'Who', cell: (p) => p.name ?? '—' },
            { key: 'status', header: 'Status', cell: (p) => p.status },
            {
              key: 'scopes',
              header: 'May',
              cell: (p) => p.scopes.map((s) => s.replace('_', ' ')).join(', '),
            },
            {
              key: 'until',
              header: 'Until',
              cell: (p) => formatDate(p.expiresAt),
            },
          ]}
        />
      </QueryState>
    </Card>
  );
}

function Contracts({
  unitId,
  occupants,
  nameOf,
}: {
  unitId: string;
  occupants: Occupant[];
  nameOf: (id: string) => string;
}) {
  const toast = useToast();
  const [recording, setRecording] = useState<{ renews?: Contract } | null>(
    null,
  );
  const [voiding, setVoiding] = useState<Contract | null>(null);
  const list = useQuery({
    queryKey: contractsKey(unitId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/contracts', {
          params: { path: { unitId } },
        }),
      ),
  });
  const open = useAction(
    (c: Contract) =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/contracts/{id}', {
          params: { path: { unitId, id: c.id } },
        }),
      ),
    {
      onDone: (r) => r.fileUrl && window.open(r.fileUrl, '_blank', 'noopener'),
    },
  );
  const voidIt = useAction(
    (v: { c: Contract; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/contracts/{id}/void', {
          params: { path: { id: v.c.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [contractsKey(unitId)],
      onDone: () => {
        toast.show('Voided. It stays on record.');
        setVoiding(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader
        title="Contracts"
        actions={
          <Button onClick={() => setRecording({})}>Record a contract</Button>
        }
      />
      <ErrorAlert error={open.error} />
      <QueryState query={list}>
        <DataTable<Contract>
          rows={list.data}
          rowKey={(c) => c.id}
          empty="No contract on record"
          emptyHint="Record the lease or the ownership contract the management holds a copy of."
          columns={[
            {
              key: 'ref',
              header: 'Contract',
              cell: (c) => <span className="t-mono">{c.reference}</span>,
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (c) => (c.kind === 'lease' ? 'Lease' : 'Ownership'),
            },
            {
              key: 'who',
              header: 'Binds',
              cell: (c) => c.partyOccupancyIds.map(nameOf).join(', '),
            },
            {
              key: 'dates',
              header: 'Dates',
              cell: (c) =>
                c.endsOn
                  ? `${formatDate(c.startsOn)} → ${formatDate(c.endsOn)} (decide by ${formatDate(c.noticeBy!)})`
                  : `From ${formatDate(c.startsOn)}`,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => (
                <Badge tone={c.status === 'live' ? 'green' : 'beige'}>
                  {c.status}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: '',
              cell: (c) => (
                <span style={{ display: 'flex', gap: 8 }}>
                  {c.hasFile ? (
                    <Button size="sm" onClick={() => open.mutate(c)}>
                      Open
                    </Button>
                  ) : null}
                  {c.kind === 'lease' && c.status === 'live' ? (
                    <Button
                      size="sm"
                      onClick={() => setRecording({ renews: c })}
                    >
                      Renew
                    </Button>
                  ) : null}
                  {c.status !== 'voided' ? (
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => setVoiding(c)}
                    >
                      Void
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </QueryState>
      {recording ? (
        <RecordContract
          unitId={unitId}
          occupants={occupants}
          renews={recording.renews}
          onClose={() => setRecording(null)}
        />
      ) : null}
      <ReasonCodeDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title="Void the contract"
        description="It stops counting and stays on record; record the right one again."
        codes={REASON_CODES.contractVoid}
        confirmLabel="Void"
        danger
        pending={voidIt.isPending}
        error={voidIt.error ? errorText(voidIt.error) : undefined}
        onConfirm={(reasonCode) =>
          voiding && voidIt.mutate({ c: voiding, reasonCode })
        }
      />
    </Card>
  );
}

function RecordContract({
  unitId,
  occupants,
  renews,
  onClose,
}: {
  unitId: string;
  occupants: Occupant[];
  renews?: Contract;
  onClose: () => void;
}) {
  const toast = useToast();
  const [v, setV] = useState({
    kind: renews ? 'lease' : 'lease',
    party: renews?.partyOccupancyIds[0] ?? '',
    signedOn: '',
    startsOn: '',
    endsOn: '',
    noticeDays: '60',
    fileId: '',
    renewalRequestId: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const eligible = occupants.filter((o) =>
    v.kind === 'lease'
      ? o.occupancyType === 'tenant'
      : o.occupancyType === 'owner',
  );
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/contracts', {
          params: { path: { unitId } },
          body: {
            kind: v.kind as Schema<'NewContractDto'>['kind'],
            partyOccupancyIds: [v.party],
            signedOn: v.signedOn,
            startsOn: v.startsOn,
            fileId: v.fileId,
            ...(v.kind === 'lease'
              ? { endsOn: v.endsOn, noticeDays: Number(v.noticeDays) }
              : {}),
            ...(renews ? { renewsId: renews.id } : {}),
            ...(v.renewalRequestId
              ? { renewalRequestId: v.renewalRequestId }
              : {}),
          },
        }),
      ),
    {
      invalidate: [contractsKey(unitId), ['contract-renewals']],
      onDone: () => {
        toast.show('Recorded. The parties see it in the app.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={renews ? `Renew ${renews.reference}` : 'Record a contract'}
      description="A copy the management holds: no signature happens here, no money moves."
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate(undefined);
      }}
      footer={
        <Button
          variant="primary"
          type="submit"
          loading={record.isPending}
          disabled={!v.fileId || !v.party}
        >
          Record
        </Button>
      }
    >
      <ErrorAlert error={record.error} />
      {renews ? null : (
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={v.kind} onChange={set('kind')}>
              <option value="lease">Lease</option>
              <option value="ownership">Ownership</option>
            </Select>
          )}
        </Field>
      )}
      <Field label={v.kind === 'lease' ? 'The tenant' : 'The owner'}>
        {(p) => (
          <Select {...p} value={v.party} onChange={set('party')} required>
            <option value="">Choose…</option>
            {eligible.map((o) => (
              <option key={o.occupancyId} value={o.occupancyId}>
                {o.account.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Signed on">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={v.signedOn}
            onChange={set('signedOn')}
            required
          />
        )}
      </Field>
      <Field label="Starts on">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={v.startsOn}
            onChange={set('startsOn')}
            required
          />
        )}
      </Field>
      {v.kind === 'lease' ? (
        <>
          <Field label="Ends on">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={v.endsOn}
                onChange={set('endsOn')}
                required
              />
            )}
          </Field>
          <Field label="Notice (days before the end)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={365}
                value={v.noticeDays}
                onChange={set('noticeDays')}
                required
              />
            )}
          </Field>
        </>
      ) : null}
      {renews ? (
        <Field
          label="The renewal request it answers"
          hint="Optional: its id from Renewal requests."
        >
          {(p) => (
            <Input
              {...p}
              value={v.renewalRequestId}
              onChange={set('renewalRequestId')}
            />
          )}
        </Field>
      ) : null}
      <FileUpload
        purpose="contract"
        label={v.fileId ? 'Scan attached — replace' : 'Attach the scan'}
        onUploaded={(fileId) => setV({ ...v, fileId })}
      />
    </Dialog>
  );
}

function Documents({ unitId }: { unitId: string }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: documentsKey(unitId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/documents', {
          params: { path: { unitId } },
        }),
      ),
  });
  const open = useAction(
    (d: Doc) =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/documents/{id}', {
          params: { path: { unitId, id: d.id } },
        }),
      ),
    { onDone: (r) => window.open(r.url, '_blank', 'noopener') },
  );
  const remove = useAction(
    (d: Doc) =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/documents/{id}/delete', {
          params: { path: { unitId, id: d.id } },
        }),
      ),
    {
      invalidate: [documentsKey(unitId)],
      onDone: () => toast.show('Deleted.'),
    },
  );
  return (
    <Card flush>
      <CardHeader
        title="Documents the management keeps"
        actions={
          <Button onClick={() => setAdding(true)}>Add a document</Button>
        }
      />
      <ErrorAlert error={open.error ?? remove.error} />
      <QueryState query={list}>
        <DataTable<Doc>
          rows={list.data}
          rowKey={(d) => d.id}
          empty="None yet"
          emptyHint="A handover report, the developer's warranties, manuals. Residents' own uploads stay theirs and are not shown here."
          columns={[
            { key: 'title', header: 'Document', cell: (d) => d.title },
            {
              key: 'kind',
              header: 'Kind',
              cell: (d) => (
                <Badge tone="beige">{d.kind.replace('_', ' ')}</Badge>
              ),
            },
            {
              key: 'who',
              header: 'Seen by',
              cell: (d) =>
                d.visibility === 'owners'
                  ? 'The owners'
                  : d.visibility === 'occupants'
                    ? 'Everyone living there'
                    : 'Its occupant',
            },
            {
              key: 'ends',
              header: 'Warranty ends',
              cell: (d) => (d.expiresOn ? formatDate(d.expiresOn) : '—'),
            },
            {
              key: 'act',
              header: '',
              cell: (d) => (
                <span style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" onClick={() => open.mutate(d)}>
                    Open
                  </Button>
                  {d.holder === 'unit' ? (
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => remove.mutate(d)}
                    >
                      Delete
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </QueryState>
      {adding ? (
        <AddDocument unitId={unitId} onClose={() => setAdding(false)} />
      ) : null}
    </Card>
  );
}

function AddDocument({
  unitId,
  onClose,
}: {
  unitId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [v, setV] = useState({
    title: '',
    kind: 'handover_report',
    visibility: 'occupants',
    expiresOn: '',
    fileId: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/documents', {
          params: { path: { unitId } },
          body: {
            fileId: v.fileId,
            kind: v.kind as Schema<'NewUnitDocumentDto'>['kind'],
            title: v.title,
            visibility: v.visibility as Schema<'NewUnitDocumentDto'>['visibility'],
            ...(v.kind === 'warranty' ? { expiresOn: v.expiresOn } : {}),
          },
        }),
      ),
    {
      invalidate: [documentsKey(unitId)],
      onDone: () => {
        toast.show('Added. Its readers see it in the app.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a document"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
      }}
      footer={
        <Button
          variant="primary"
          type="submit"
          loading={add.isPending}
          disabled={!v.fileId}
        >
          Add
        </Button>
      }
    >
      <ErrorAlert error={add.error} />
      <Field label="Title">
        {(p) => (
          <Input
            {...p}
            maxLength={120}
            value={v.title}
            onChange={set('title')}
            required
          />
        )}
      </Field>
      <Field label="Kind">
        {(p) => (
          <Select {...p} value={v.kind} onChange={set('kind')}>
            {[
              'handover_report',
              'warranty',
              'manual',
              'utility',
              'insurance',
              'inspection_report',
              'other',
            ].map((k) => (
              <option key={k} value={k}>
                {k.replace('_', ' ')}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Seen by">
        {(p) => (
          <Select {...p} value={v.visibility} onChange={set('visibility')}>
            <option value="occupants">Everyone living there</option>
            <option value="owners">The owners</option>
          </Select>
        )}
      </Field>
      {v.kind === 'warranty' ? (
        <Field
          label="Warranty ends"
          hint="Its readers are told 30 days before."
        >
          {(p) => (
            <Input
              {...p}
              type="date"
              value={v.expiresOn}
              onChange={set('expiresOn')}
              required
            />
          )}
        </Field>
      ) : null}
      <FileUpload
        purpose="unit_document"
        label={v.fileId ? 'File attached — replace' : 'Attach the file'}
        onUploaded={(fileId) => setV({ ...v, fileId })}
      />
    </Dialog>
  );
}

function Deposits({
  unitId,
  occupants,
  nameOf,
}: {
  unitId: string;
  occupants: Occupant[];
  nameOf: (id: string) => string;
}) {
  const { can } = usePermissions();
  const [recording, setRecording] = useState(false);
  const [settling, setSettling] = useState<Deposit | null>(null);
  const list = useQuery({
    queryKey: depositsKey(unitId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/deposits', {
          params: { path: { unitId } },
        }),
      ),
  });
  return (
    <Card flush>
      <CardHeader
        title="Deposits held"
        actions={
          <Button onClick={() => setRecording(true)}>Record a deposit</Button>
        }
      />
      <QueryState query={list}>
        <DataTable<Deposit>
          rows={list.data}
          rowKey={(d) => d.id}
          empty="No deposit held"
          emptyHint="Money the management holds: a finishing-works or a move deposit, the maintenance fund."
          columns={[
            {
              key: 'n',
              header: 'Deposit',
              cell: (d) => <span className="t-mono">{d.number}</span>,
            },
            { key: 'who', header: 'For', cell: (d) => nameOf(d.occupancyId) },
            {
              key: 'kind',
              header: 'Kind',
              cell: (d) => d.kind.replace('_', ' '),
            },
            {
              key: 'held',
              header: 'Held',
              cell: (d) => `${d.held} of ${d.amount} EGP`,
            },
            {
              key: 'ask',
              header: '',
              cell: (d) =>
                d.refundRequested ? (
                  <Badge tone="terracotta">Refund asked</Badge>
                ) : null,
            },
            {
              key: 'act',
              header: '',
              cell: (d) =>
                can('finance.refund') && Number(d.held) > 0 ? (
                  <Button size="sm" onClick={() => setSettling(d)}>
                    Settle
                  </Button>
                ) : null,
            },
          ]}
        />
      </QueryState>
      {recording ? (
        <RecordDeposit
          unitId={unitId}
          occupants={occupants}
          onClose={() => setRecording(false)}
        />
      ) : null}
      {settling ? (
        <SettleDeposit
          unitId={unitId}
          deposit={settling}
          onClose={() => setSettling(null)}
        />
      ) : null}
    </Card>
  );
}

function RecordDeposit({
  unitId,
  occupants,
  onClose,
}: {
  unitId: string;
  occupants: Occupant[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [v, setV] = useState({
    occupancyId: '',
    kind: 'finishing_works',
    amount: '',
    receivedOn: '',
    method: 'bank_transfer',
    reference: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/deposits', {
          body: {
            occupancyId: v.occupancyId,
            kind: v.kind as Schema<'NewDepositDto'>['kind'],
            amount: v.amount,
            receivedOn: v.receivedOn,
            method: v.method as Schema<'NewDepositDto'>['method'],
            ...(v.reference ? { reference: v.reference } : {}),
          },
        }),
      ),
    {
      invalidate: [depositsKey(unitId)],
      onDone: () => {
        toast.show('Recorded.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record a deposit received"
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate(undefined);
      }}
      footer={
        <Button variant="primary" type="submit" loading={record.isPending}>
          Record
        </Button>
      }
    >
      <ErrorAlert error={record.error} />
      <Field label="For">
        {(p) => (
          <Select
            {...p}
            value={v.occupancyId}
            onChange={set('occupancyId')}
            required
          >
            <option value="">Choose…</option>
            {occupants.map((o) => (
              <option key={o.occupancyId} value={o.occupancyId}>
                {o.account.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Kind">
        {(p) => (
          <Select {...p} value={v.kind} onChange={set('kind')}>
            <option value="finishing_works">Finishing works</option>
            <option value="move">Move</option>
            <option value="maintenance_fund">Maintenance fund</option>
            <option value="other">Other</option>
          </Select>
        )}
      </Field>
      <Field label="Amount (EGP)">
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.amount}
            onChange={set('amount')}
            required
          />
        )}
      </Field>
      <Field label="Received on">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={v.receivedOn}
            onChange={set('receivedOn')}
            required
          />
        )}
      </Field>
      <Field label="How">
        {(p) => (
          <Select {...p} value={v.method} onChange={set('method')}>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
          </Select>
        )}
      </Field>
      <Field label="Reference" hint="Optional.">
        {(p) => (
          <Input
            {...p}
            maxLength={100}
            value={v.reference}
            onChange={set('reference')}
          />
        )}
      </Field>
    </Dialog>
  );
}

function SettleDeposit({
  unitId,
  deposit,
  onClose,
}: {
  unitId: string;
  deposit: Deposit;
  onClose: () => void;
}) {
  const toast = useToast();
  const [stepping, setStepping] = useState(false);
  const [v, setV] = useState({
    refund: deposit.held,
    channel: 'bank_transfer',
    dues: '',
    damage: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const settle = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/deposits/{id}/settle', {
          params: { path: { id: deposit.id } },
          body: {
            ...(Number(v.refund) > 0
              ? { refund: { amount: v.refund, channel: v.channel as 'cash' | 'bank_transfer' } }
              : {}),
            deductions: [
              ...(Number(v.dues) > 0
                ? [{ reasonCode: 'unpaid_dues', amount: v.dues }]
                : []),
              ...(Number(v.damage) > 0
                ? [{ reasonCode: 'damage', amount: v.damage }]
                : []),
            ],
          },
        }),
      ),
    {
      invalidate: [depositsKey(unitId)],
      onDone: () => {
        toast.show(
          'Settled. Unpaid dues taken from it are paid on the unit’s invoices.',
        );
        onClose();
      },
    },
  );
  if (stepping)
    return (
      <StepUpDialog
        title="Confirm it is you"
        description="Settling a deposit moves money: we sent a code to your email."
        onClose={() => setStepping(false)}
        onVerified={() => {
          setStepping(false);
          settle.mutate(undefined);
        }}
      />
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Settle ${deposit.number}`}
      description={`${deposit.held} EGP held. Never more than that in all.`}
      onSubmit={(e) => {
        e.preventDefault();
        setStepping(true);
      }}
      footer={
        <Button variant="primary" type="submit" loading={settle.isPending}>
          Settle
        </Button>
      }
    >
      <ErrorAlert error={settle.error} />
      <Field label="Refund (EGP)">
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.refund}
            onChange={set('refund')}
          />
        )}
      </Field>
      <Field label="Refund by">
        {(p) => (
          <Select {...p} value={v.channel} onChange={set('channel')}>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cash">Cash</option>
          </Select>
        )}
      </Field>
      <Field
        label="Kept for unpaid dues (EGP)"
        hint="Paid on the unit’s open invoices."
      >
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.dues}
            onChange={set('dues')}
          />
        )}
      </Field>
      <Field label="Kept for damage (EGP)">
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.damage}
            onChange={set('damage')}
          />
        )}
      </Field>
    </Dialog>
  );
}

function Clearance({ unitId }: { unitId: string }) {
  const toast = useToast();
  const issue = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/clearances', {
          params: { path: { unitId } },
        }),
      ),
    {
      onDone: async (c) => {
        toast.show(
          `${c.number} issued, valid until ${formatDate(c.validUntil)}.`,
        );
        await download(
          `/api/v1/staff/clearances/${c.id}/certificate`,
          {},
          `${c.number}.pdf`,
        );
      },
    },
  );
  return (
    <Card>
      <CardHeader title="Clearance certificate" />
      <p className="t-secondary">
        Issued only when the unit owes nothing, open disputes included; anyone
        checks it with the code printed on it.
      </p>
      <ErrorAlert error={issue.error} />
      <Button onClick={() => issue.mutate(undefined)} loading={issue.isPending}>
        Issue and download
      </Button>
      {issue.data ? (
        <p className="t-secondary">
          Last issued {formatDateTime(issue.data.asOf)}.
        </p>
      ) : null}
    </Card>
  );
}
