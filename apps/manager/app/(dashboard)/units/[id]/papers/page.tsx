'use client';

import { ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
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
import ar from '@/messages/ar/units-papers';
import en from '@/messages/en/units-papers';

type Contract = Schema<'ContractView'>;
type Doc = Schema<'UnitDocumentView'>;
type Deposit = Schema<'DepositView'>;
type Occupant = Schema<'UnitOccupantView'>;

const contractsKey = (u: string) => ['units', u, 'contracts'] as const;
const documentsKey = (u: string) => ['units', u, 'documents'] as const;
const depositsKey = (u: string) => ['units', u, 'deposits'] as const;

const DOC_KINDS = ['handover_report', 'warranty', 'manual', 'utility', 'insurance', 'inspection_report', 'other'] as const;
const DEPOSIT_KINDS = ['finishing_works', 'move', 'maintenance_fund', 'other'] as const;
const docKind = (m: Record<string, string>) =>
  Object.fromEntries(DOC_KINDS.map((k) => [k, m[`docKind.${k}`]!]));
const depositKind = (m: Record<string, string>) =>
  Object.fromEntries(DEPOSIT_KINDS.map((k) => [k, m[`depositKind.${k}`]!]));
/** A document's and a deposit's kind in this page's words (the shared `manual` means "by hand"). */
const DOC_KIND_LABELS = { en: docKind(en), ar: docKind(ar) };
const DEPOSIT_KIND_LABELS = { en: depositKind(en), ar: depositKind(ar) };

/**
 * A unit's papers (ADR 0062): its contracts (leases, ownership), the
 * documents the management keeps in its vault (residents' own uploads are
 * theirs alone), the deposits the management holds for its occupants, and
 * a clearance certificate when the unit owes nothing.
 */
export default function UnitPapersPage() {
  const t = useT(en, ar);
  const { id: unitId } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const unit = useQuery({
    queryKey: keys.unit(unitId),
    queryFn: () => fetchers.unit(unitId),
  });
  const occupants: Occupant[] = unit.data?.occupants ?? [];
  const nameOf = (occupancyId: string) =>
    occupants.find((o) => o.occupancyId === occupancyId)?.account.fullName ??
    t('formerOccupant');

  return (
    <>
      <PageHeader
        title={unit.data ? t('title', { code: unit.data.code }) : t('titleUnnamed')}
        description={t('description')}
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
 * The unit's proxies (ADR 0063): its owners appoint and revoke them from
 * the app; a proxy acts while the unit is closed or has no primary. The
 * management ends one with a reason (ADR 0083): the proxy and the owner who
 * appointed it are told.
 */
function Proxies({ unitId }: { unitId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [revoking, setRevoking] = useState<Schema<'ProxyView'> | null>(null);
  const key = ['unit-proxies', unitId] as const;
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/units/{unitId}/proxies', {
          params: { path: { unitId } },
        }),
      ),
  });
  const revoke = useAction(
    (v: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/proxies/{id}/revoke', {
          params: { path: { unitId, id: v.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [key],
      onDone: () => {
        toast.show(t('proxyEnded'));
        setRevoking(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader title={t('proxies')} />
      <QueryState query={list}>
        <DataTable<Schema<'ProxyView'>>
          rows={list.data}
          rowKey={(p) => p.id}
          empty={t('proxiesEmpty')}
          emptyHint={t('proxiesEmptyHint')}
          columns={[
            { key: 'name', header: t('col.who'), cell: (p) => p.name ?? '—' },
            {
              key: 'status',
              header: c('status'),
              cell: (p) =>
                p.status === 'ended' && p.revokeCode
                  ? t('endedByManagement', { reason: label(p.revokeCode) })
                  : label(p.status),
            },
            {
              key: 'scopes',
              header: t('col.may'),
              cell: (p) => fmt.list(p.scopes.map((s) => label(s))),
            },
            {
              key: 'until',
              header: t('col.until'),
              cell: (p) => fmt.date(p.expiresAt),
            },
            {
              key: 'act',
              header: '',
              cell: (p) =>
                p.status === 'ended' ? null : (
                  <Button size="sm" onClick={() => setRevoking(p)}>
                    {t('end')}
                  </Button>
                ),
            },
          ]}
        />
      </QueryState>
      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('endProxyTitle')}
        description={t('endProxyDescription')}
        codes={REASON_CODES.proxyRevokeByManagement}
        confirmLabel={t('endProxyConfirm')}
        danger
        pending={revoke.isPending}
        error={revoke.error ? <ErrorText error={revoke.error} /> : undefined}
        onConfirm={(reasonCode) =>
          revoking && revoke.mutate({ id: revoking.id, reasonCode })
        }
      />
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(t('voided'));
        setVoiding(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader
        title={t('contracts')}
        actions={
          <Button onClick={() => setRecording({})}>{t('recordContract')}</Button>
        }
      />
      <ErrorAlert error={open.error} />
      <QueryState query={list}>
        <DataTable<Contract>
          rows={list.data}
          rowKey={(k) => k.id}
          empty={t('contractsEmpty')}
          emptyHint={t('contractsEmptyHint')}
          columns={[
            {
              key: 'ref',
              header: t('col.contract'),
              cell: (k) => <span className="t-mono">{k.reference}</span>,
            },
            {
              key: 'kind',
              header: c('kind'),
              cell: (k) => (k.kind === 'lease' ? t('kind.lease') : t('kind.ownership')),
            },
            {
              key: 'who',
              header: t('col.binds'),
              cell: (k) => fmt.list(k.partyOccupancyIds.map(nameOf)),
            },
            {
              key: 'dates',
              header: t('col.dates'),
              cell: (k) =>
                k.endsOn
                  ? t('datesLease', { start: fmt.day(k.startsOn), end: fmt.day(k.endsOn), notice: fmt.day(k.noticeBy) })
                  : t('datesFrom', { start: fmt.day(k.startsOn) }),
            },
            {
              key: 'status',
              header: c('status'),
              cell: (k) => (
                <Badge tone={k.status === 'live' ? 'green' : 'beige'}>
                  {label(k.status)}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: '',
              cell: (k) => (
                <span style={{ display: 'flex', gap: 8 }}>
                  {k.hasFile ? (
                    <Button size="sm" onClick={() => open.mutate(k)}>
                      {c('open')}
                    </Button>
                  ) : null}
                  {k.kind === 'lease' && k.status === 'live' ? (
                    <Button
                      size="sm"
                      onClick={() => setRecording({ renews: k })}
                    >
                      {t('renew')}
                    </Button>
                  ) : null}
                  {k.status !== 'voided' ? (
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => setVoiding(k)}
                    >
                      {t('void')}
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
        title={t('voidTitle')}
        description={t('voidDescription')}
        codes={REASON_CODES.contractVoid}
        confirmLabel={t('void')}
        danger
        pending={voidIt.isPending}
        error={voidIt.error ? <ErrorText error={voidIt.error} /> : undefined}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('contractRecorded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={renews ? t('renewTitle', { reference: renews.reference }) : t('recordContract')}
      description={t('recordDescription')}
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
          {t('record')}
        </Button>
      }
    >
      <ErrorAlert error={record.error} />
      {renews ? null : (
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={v.kind} onChange={set('kind')}>
              <option value="lease">{t('kind.lease')}</option>
              <option value="ownership">{t('kind.ownership')}</option>
            </Select>
          )}
        </Field>
      )}
      <Field label={v.kind === 'lease' ? t('theTenant') : t('theOwner')}>
        {(p) => (
          <Select {...p} value={v.party} onChange={set('party')} required>
            <option value="">{t('choose')}</option>
            {eligible.map((o) => (
              <option key={o.occupancyId} value={o.occupancyId}>
                {o.account.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('signedOn')}>
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
      <Field label={t('startsOn')}>
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
          <Field label={t('endsOn')}>
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
          <Field label={t('noticeDays')}>
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
          label={t('renewalRequest')}
          hint={t('renewalRequestHint')}
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
        label={v.fileId ? t('scanAttached') : t('attachScan')}
        onUploaded={(fileId) => setV({ ...v, fileId })}
      />
    </Dialog>
  );
}

function Documents({ unitId }: { unitId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const kindText = useLabel(DOC_KIND_LABELS);
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
      onDone: () => toast.show(t('deleted')),
    },
  );
  return (
    <Card flush>
      <CardHeader
        title={t('documents')}
        actions={
          <Button onClick={() => setAdding(true)}>{t('addDocument')}</Button>
        }
      />
      <ErrorAlert error={open.error ?? remove.error} />
      <QueryState query={list}>
        <DataTable<Doc>
          rows={list.data}
          rowKey={(d) => d.id}
          empty={t('documentsEmpty')}
          emptyHint={t('documentsEmptyHint')}
          columns={[
            { key: 'title', header: t('col.document'), cell: (d) => d.title },
            {
              key: 'kind',
              header: c('kind'),
              cell: (d) => <Badge tone="beige">{kindText(d.kind)}</Badge>,
            },
            {
              key: 'who',
              header: t('col.seenBy'),
              cell: (d) =>
                d.visibility === 'owners'
                  ? t('seenBy.owners')
                  : d.visibility === 'occupants'
                    ? t('seenBy.occupants')
                    : t('seenBy.private'),
            },
            {
              key: 'ends',
              header: t('col.warrantyEnds'),
              cell: (d) => (d.expiresOn ? fmt.day(d.expiresOn) : '—'),
            },
            {
              key: 'act',
              header: '',
              cell: (d) => (
                <span style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" onClick={() => open.mutate(d)}>
                    {c('open')}
                  </Button>
                  {d.holder === 'unit' ? (
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => remove.mutate(d)}
                    >
                      {c('delete')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const kindText = useLabel(DOC_KIND_LABELS);
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
        toast.show(t('documentAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('addDocument')}
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
          {c('add')}
        </Button>
      }
    >
      <ErrorAlert error={add.error} />
      <Field label={t('docTitle')}>
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
      <Field label={c('kind')}>
        {(p) => (
          <Select {...p} value={v.kind} onChange={set('kind')}>
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindText(k)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('col.seenBy')}>
        {(p) => (
          <Select {...p} value={v.visibility} onChange={set('visibility')}>
            <option value="occupants">{t('seenBy.occupants')}</option>
            <option value="owners">{t('seenBy.owners')}</option>
          </Select>
        )}
      </Field>
      {v.kind === 'warranty' ? (
        <Field label={t('col.warrantyEnds')} hint={t('warrantyHint')}>
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
        label={v.fileId ? t('fileAttached') : t('attachFile')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const kindText = useLabel(DEPOSIT_KIND_LABELS);
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
        title={t('deposits')}
        actions={
          <Button onClick={() => setRecording(true)}>{t('recordDeposit')}</Button>
        }
      />
      <QueryState query={list}>
        <DataTable<Deposit>
          rows={list.data}
          rowKey={(d) => d.id}
          empty={t('depositsEmpty')}
          emptyHint={t('depositsEmptyHint')}
          columns={[
            {
              key: 'n',
              header: t('col.deposit'),
              cell: (d) => <span className="t-mono ltr">{d.number}</span>,
            },
            { key: 'who', header: t('col.for'), cell: (d) => nameOf(d.occupancyId) },
            {
              key: 'kind',
              header: c('kind'),
              cell: (d) => kindText(d.kind),
            },
            {
              key: 'held',
              header: t('col.held'),
              cell: (d) => t('heldOf', { held: fmt.number(d.held), amount: fmt.money(d.amount) }),
            },
            {
              key: 'ask',
              header: '',
              cell: (d) =>
                d.refundRequested ? (
                  <Badge tone="terracotta">{t('refundAsked')}</Badge>
                ) : null,
            },
            {
              key: 'act',
              header: '',
              cell: (d) =>
                can('finance.refund') && Number(d.held) > 0 ? (
                  <Button size="sm" onClick={() => setSettling(d)}>
                    {t('settle')}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('depositRecorded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('recordDepositTitle')}
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate(undefined);
      }}
      footer={
        <Button variant="primary" type="submit" loading={record.isPending}>
          {t('record')}
        </Button>
      }
    >
      <ErrorAlert error={record.error} />
      <Field label={t('col.for')}>
        {(p) => (
          <Select
            {...p}
            value={v.occupancyId}
            onChange={set('occupancyId')}
            required
          >
            <option value="">{t('choose')}</option>
            {occupants.map((o) => (
              <option key={o.occupancyId} value={o.occupancyId}>
                {o.account.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={c('kind')}>
        {(p) => (
          <Select {...p} value={v.kind} onChange={set('kind')}>
            <option value="finishing_works">{t('depositKind.finishing_works')}</option>
            <option value="move">{t('depositKind.move')}</option>
            <option value="maintenance_fund">{t('depositKind.maintenance_fund')}</option>
            <option value="other">{t('depositKind.other')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('amountEgp')}>
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
      <Field label={t('receivedOn')}>
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
      <Field label={t('how')}>
        {(p) => (
          <Select {...p} value={v.method} onChange={set('method')}>
            <option value="bank_transfer">{t('method.bank_transfer')}</option>
            <option value="cash">{t('method.cash')}</option>
            <option value="cheque">{t('method.cheque')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('reference')} hint={t('optionalHint')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
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
        toast.show(t('settled'));
        onClose();
      },
    },
  );
  if (stepping)
    return (
      <StepUpDialog
        title={t('confirmItsYou')}
        description={t('settleStepUp')}
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
      title={t('settleTitle', { number: deposit.number })}
      description={t('settleDescription', { held: fmt.money(deposit.held) })}
      onSubmit={(e) => {
        e.preventDefault();
        setStepping(true);
      }}
      footer={
        <Button variant="primary" type="submit" loading={settle.isPending}>
          {t('settle')}
        </Button>
      }
    >
      <ErrorAlert error={settle.error} />
      <Field label={t('refundEgp')}>
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.refund}
            onChange={set('refund')}
          />
        )}
      </Field>
      <Field label={t('refundBy')}>
        {(p) => (
          <Select {...p} value={v.channel} onChange={set('channel')}>
            <option value="bank_transfer">{t('method.bank_transfer')}</option>
            <option value="cash">{t('method.cash')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('keptDues')} hint={t('keptDuesHint')}>
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            value={v.dues}
            onChange={set('dues')}
          />
        )}
      </Field>
      <Field label={t('keptDamage')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
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
        toast.show(t('clearanceIssued', { number: c.number, date: fmt.date(c.validUntil) }));
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
      <CardHeader title={t('clearance')} />
      <p className="t-secondary">{t('clearanceHint')}</p>
      <ErrorAlert error={issue.error} />
      <Button onClick={() => issue.mutate(undefined)} loading={issue.isPending}>
        {t('issueDownload')}
      </Button>
      {issue.data ? (
        <p className="t-secondary">
          {t('lastIssued', { when: fmt.dateTime(issue.data.asOf) })}
        </p>
      ) : null}
    </Card>
  );
}
