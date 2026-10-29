'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
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
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EditAssetDialog } from '@/components/assets/asset-dialogs';
import { CONDITION_TONE, eventText, HEALTH_TONE, placeText } from '@/components/assets/format';
import { TagDialog } from '@/components/assets/tag-dialog';
import { AssetContractsPanel, AssetEconomicsPanel } from '@/components/operations/asset-economics';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetCard, type AssetEvent, type MaintenanceDocument, type PlanSummary } from '@/lib/queries';

type Open = 'edit' | 'out' | 'retire' | 'move' | null;

function Facts({ a }: { a: AssetCard }) {
  const row = (label: string, value: string | null | number) => (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === '' ? '—' : value}</dd>
    </>
  );
  return (
    <Card flush>
      <CardHeader title="Card" />
      <CardBody>
        <dl className="dl">
          {row('Where', placeText(a))}
          {row('Type', a.type.nameEn)}
          {row('Name (Arabic)', a.nameAr)}
          {row('Manufacturer', a.manufacturer)}
          {row('Model', a.model)}
          {row('Serial number', a.serialNumber)}
          {row('In service since', a.commissionedOn ? formatDate(a.commissionedOn) : null)}
          {row('Age', a.ageYears === null ? null : `${a.ageYears} years of ${a.lifeYears ?? '?'} expected`)}
          {row('Purchase value', a.purchaseValue ? `${a.purchaseValue} EGP` : null)}
          {row('Replacement cost', a.replacementCost ? `${a.replacementCost} EGP` : null)}
          {row('Vendor', a.vendorName ? `${a.vendorName}${a.vendorPhone ? ` · ${a.vendorPhone}` : ''}` : null)}
          {row('Warranty', a.warrantyEndsOn ? `${a.underWarranty ? 'Until' : 'Ended'} ${formatDate(a.warrantyEndsOn)}` : null)}
          {row('Serves', a.servesBuildings.join(', ') || null)}
          {row('Parts', a.childCount)}
          {row('Tag', a.tagIssuedAt ? `Issued ${formatDateTime(a.tagIssuedAt)}` : null)}
        </dl>
      </CardBody>
    </Card>
  );
}

function Impact({ id }: { id: string }) {
  const impact = useQuery({ queryKey: keys.assetPart(id, 'impact'), queryFn: () => fetchers.assetImpact(id) });
  return (
    <Card flush>
      <CardHeader title="Who its failure reaches" />
      <CardBody>
        <QueryState query={impact}>
          {impact.data ? (
            <p>
              {impact.data.units} unit{impact.data.units === 1 ? '' : 's'}, {impact.data.occupiedUnits} lived in
              {impact.data.buildings.length ? ` · ${impact.data.buildings.join(', ')}` : ''}
            </p>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

function History({ id }: { id: string }) {
  const list = useCursorList(keys.assetPart(id, 'events'), (c) => fetchers.assetEvents(id, c));
  return (
    <Card flush>
      <CardHeader title="History" />
      <QueryState query={list}>
        <DataTable<AssetEvent>
          rows={list.rows}
          rowKey={(e) => e.id}
          empty="Nothing yet"
          columns={[
            { key: 'when', header: 'When', width: 170, cell: (e) => formatDateTime(e.occurredAt) },
            { key: 'what', header: 'What', cell: (e) => eventText(e) },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

function Documents({ id }: { id: string }) {
  const { can } = usePermissions();
  const toast = useToast();
  const docs = useQuery({ queryKey: keys.documents({ assetId: id }), queryFn: () => fetchers.documents({ assetId: id }) });
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MaintenanceDocument['kind']>('manual');
  const add = useAction(
    (fileId: string) =>
      unwrap(api.POST('/api/v1/maintenance/documents', { body: { assetId: id, fileId, kind, title: title.trim() || 'Document' } })),
    {
      invalidate: [keys.documents({ assetId: id })],
      onDone: () => {
        setTitle('');
        toast.show('Document added.');
      },
    },
  );
  const remove = useAction(
    (docId: string) => unwrap(api.POST('/api/v1/maintenance/documents/{id}/remove', { params: { path: { id: docId } } })),
    { invalidate: [keys.documents({ assetId: id })], onDone: () => toast.show('Document removed.') },
  );
  return (
    <Card flush>
      <CardHeader title="Documents" />
      <CardBody>
        <QueryState query={docs}>
          <ul className="list">
            {(docs.data?.data ?? []).map((d) => (
              <li key={d.id} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <span>
                  {d.url ? (
                    <a className="table__link" href={d.url} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                  ) : (
                    d.title
                  )}{' '}
                  <span className="t-secondary">· {humanize(d.kind)}</span>
                </span>
                {can('assets.manage') ? (
                  <Button size="sm" onClick={() => remove.mutate(d.id)}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </QueryState>
        {can('assets.manage') ? (
          <div className="form" style={{ marginTop: 12 }}>
            <div className="form__row">
              <Field label="Title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label="Kind">
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as MaintenanceDocument['kind'])}>
                    {['plan', 'manual', 'warranty', 'certificate', 'photo', 'other'].map((k) => (
                      <option key={k} value={k}>
                        {humanize(k)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <FileUpload purpose="asset_document" label="Add a document" disabled={add.isPending} onUploaded={(f) => add.mutateAsync(f).then(() => undefined)} />
            <ErrorAlert error={add.error} />
            <ErrorAlert error={remove.error} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Plans({ id }: { id: string }) {
  const list = useCursorList(keys.plans({ assetId: id }), (c) => fetchers.plans({ assetId: id }, c));
  return (
    <Card flush>
      <CardHeader title="Maintenance plans" />
      <QueryState query={list}>
        <DataTable<PlanSummary>
          rows={list.rows}
          rowKey={(p) => p.id}
          empty="No plan"
          columns={[
            {
              key: 't',
              header: 'Plan',
              cell: (p) => (
                <Link className="table__link" href={`/maintenance-plans/${p.id}`}>
                  {p.title}
                </Link>
              ),
            },
            { key: 'n', header: 'Next due', cell: (p) => (p.nextDueOn ? formatDate(p.nextDueOn) : '—') },
            { key: 'a', header: 'Status', cell: (p) => (p.active ? 'On' : <Badge tone="beige">Off</Badge>) },
          ]}
        />
      </QueryState>
    </Card>
  );
}

export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const toast = useToast();
  const asset = useQuery({ queryKey: keys.asset(id), queryFn: () => fetchers.asset(id) });
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const [open, setOpen] = useState<Open>(null);
  const [to, setTo] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const refresh = { invalidate: [keys.asset(id), keys.assetsAll] };
  const close = () => {
    setOpen(null);
    for (const a of [out, retire, move, back]) a.reset();
  };
  const done = (text: string) => () => {
    toast.show(text);
    close();
  };
  const out = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/assets/{id}/status', { params: { path: { id } }, body: { status: 'out_of_service', reasonCode: reasonCode as (typeof REASON_CODES.assetOutOfService)[number] } })),
    { ...refresh, onDone: done('Out of service.') },
  );
  const back = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/assets/{id}/status', { params: { path: { id } }, body: { status: 'in_service' } })),
    { ...refresh, onDone: done('Back in service.') },
  );
  const retire = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/assets/{id}/retire', { params: { path: { id } }, body: { reasonCode: reasonCode as (typeof REASON_CODES.assetRetire)[number] } })),
    { ...refresh, onDone: done('Retired.') },
  );
  const move = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/assets/{id}/move', { params: { path: { id } }, body: { commonAreaId: to } })),
    { ...refresh, onDone: done('Moved, with its parts.') },
  );
  const tag = useAction(() => unwrap(api.POST('/api/v1/maintenance/assets/{id}/tag', { params: { path: { id } } })), {
    ...refresh,
    onDone: (t) => setCode(t.code),
  });
  const a = asset.data;
  const live = a && a.status !== 'retired';
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/assets" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Assets
          </ButtonLink>
        }
        title={
          a ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="t-mono">{a.code}</span> {a.nameEn}
              <Badge tone={CONDITION_TONE[a.condition]}>{humanize(a.condition)}</Badge>
              {a.status !== 'in_service' ? <Badge tone="terracotta">{humanize(a.statusReason ?? a.status)}</Badge> : null}
              {a.health ? <Badge tone={HEALTH_TONE[a.health.band]}>Health {a.health.score}</Badge> : null}
            </span>
          ) : (
            'Asset'
          )
        }
        description={a ? `${a.type.nameEn} · ${placeText(a)} · ${humanize(a.criticality)} criticality` : undefined}
        actions={
          a && live && can('assets.manage') ? (
            <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button onClick={() => setOpen('edit')}>Edit</Button>
              {a.status === 'in_service' ? (
                <Button onClick={() => setOpen('out')}>Out of service</Button>
              ) : (
                <Button loading={back.isPending} onClick={() => back.mutate()}>
                  Back in service
                </Button>
              )}
              {a.parentId === null ? <Button onClick={() => setOpen('move')}>Move</Button> : null}
              <Button loading={tag.isPending} onClick={() => tag.mutate()}>
                {a.tagIssuedAt ? 'New tag' : 'Issue tag'}
              </Button>
              <Button variant="danger" onClick={() => setOpen('retire')}>
                Retire
              </Button>
            </span>
          ) : undefined
        }
      />
      <ErrorAlert error={tag.error ?? back.error} />
      <QueryState query={asset}>
        {a ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Facts a={a} />
              <History id={a.id} />
            </div>
            <div className="stack">
              <Impact id={a.id} />
              <AssetEconomicsPanel id={a.id} />
              <AssetContractsPanel id={a.id} />
              <Plans id={a.id} />
              <Documents id={a.id} />
            </div>
          </div>
        ) : null}
      </QueryState>
      {a && open === 'edit' ? <EditAssetDialog asset={a} onClose={close} /> : null}
      <ReasonCodeDialog
        open={open === 'out'}
        onClose={close}
        title="Out of service"
        codes={REASON_CODES.assetOutOfService}
        confirmLabel="Take out of service"
        pending={out.isPending}
        error={<ErrorAlert error={out.error} />}
        onConfirm={(c) => out.mutate(c)}
      />
      <ReasonCodeDialog
        open={open === 'retire'}
        onClose={close}
        title="Retire for good?"
        description="Its parts are retired first. Its plans end with it."
        codes={REASON_CODES.assetRetire}
        confirmLabel="Retire"
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(c) => retire.mutate(c)}
      />
      <Dialog
        open={open === 'move'}
        onClose={close}
        title="Move with its parts"
        onSubmit={() => to && move.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={move.isPending} disabled={!to}>
              Move
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="To">
            {(p) => (
              <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Select a common area…</option>
                {(areas.data?.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} · {x.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={move.error} />
        </div>
      </Dialog>
      <TagDialog code={code} onClose={() => setCode(null)} />
    </>
  );
}
