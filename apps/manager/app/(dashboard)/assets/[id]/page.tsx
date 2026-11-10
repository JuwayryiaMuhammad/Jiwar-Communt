'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { EditAssetDialog } from '@/components/assets/asset-dialogs';
import { CONDITION_TONE, eventText, HEALTH_TONE, nameOf, placeText } from '@/components/assets/format';
import { TagDialog } from '@/components/assets/tag-dialog';
import { AssetContractsPanel, AssetEconomicsPanel } from '@/components/operations/asset-economics';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetCard, type AssetEvent, type MaintenanceDocument, type PlanSummary } from '@/lib/queries';
import { AssetTimeline, WarrantyClaims } from '@/components/assets/asset-record';
import ar from '@/messages/ar/assets-asset';
import en from '@/messages/en/assets-asset';
import formatAr from '@/messages/ar/assets-format';
import formatEn from '@/messages/en/assets-format';

type Open = 'edit' | 'out' | 'retire' | 'move' | null;
const DOC_KINDS = ['plan', 'manual', 'warranty', 'certificate', 'photo', 'other'] as const;

function Facts({ a }: { a: AssetCard }) {
  const t = useT(en, ar);
  const tf = useT(formatEn, formatAr);
  const fmt = useFormat();
  const row = (label: string, value: ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </>
  );
  return (
    <Card flush>
      <CardHeader title={t('card')} />
      <CardBody>
        <dl className="dl">
          {row(t('where'), placeText(tf, fmt.locale, a))}
          {row(t('type'), nameOf(fmt.locale, a.type))}
          {fmt.locale === 'ar' ? row(t('nameEn'), a.nameEn) : row(t('nameAr'), a.nameAr)}
          {row(t('manufacturer'), a.manufacturer)}
          {row(t('model'), a.model)}
          {row(t('serialNumber'), a.serialNumber ? <bdi>{a.serialNumber}</bdi> : null)}
          {row(t('commissionedOn'), a.commissionedOn ? fmt.day(a.commissionedOn) : null)}
          {row(
            t('age'),
            a.ageYears === null ? null : a.lifeYears === null ? t('ageOnly', { age: a.ageYears }) : t('ageValue', { age: a.ageYears, life: a.lifeYears }),
          )}
          {row(t('purchaseValue'), a.purchaseValue ? fmt.money(a.purchaseValue) : null)}
          {row(t('replacementCost'), a.replacementCost ? fmt.money(a.replacementCost) : null)}
          {row(
            t('vendor'),
            a.vendorName ? (
              <>
                {a.vendorName}
                {a.vendorPhone ? (
                  <>
                    {' · '}
                    <bdi>{a.vendorPhone}</bdi>
                  </>
                ) : null}
              </>
            ) : null,
          )}
          {row(
            t('warranty'),
            a.warrantyEndsOn ? t(a.underWarranty ? 'warrantyUntil' : 'warrantyEnded', { date: fmt.day(a.warrantyEndsOn) }) : null,
          )}
          {row(t('warrantyStartsOn'), a.warrantyStartsOn ? fmt.day(a.warrantyStartsOn) : null)}
          {row(t('warrantor'), a.warrantor)}
          {row(t('warrantyCovers'), a.warrantyCovers)}
          {row(t('serves'), a.servesBuildings.length ? fmt.list(a.servesBuildings) : null)}
          {row(t('parts'), fmt.number(a.childCount))}
          {row(t('tag'), a.tagIssuedAt ? t('tagIssued', { when: fmt.dateTime(a.tagIssuedAt) }) : null)}
        </dl>
      </CardBody>
    </Card>
  );
}

function Impact({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const impact = useQuery({ queryKey: keys.assetPart(id, 'impact'), queryFn: () => fetchers.assetImpact(id) });
  return (
    <Card flush>
      <CardHeader title={t('impact')} />
      <CardBody>
        <QueryState query={impact}>
          {impact.data ? (
            <p>
              {t('impactUnits', { units: impact.data.units, occupied: fmt.number(impact.data.occupiedUnits) })}
              {impact.data.buildings.length ? ` · ${fmt.list(impact.data.buildings)}` : ''}
            </p>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

function History({ id }: { id: string }) {
  const t = useT(en, ar);
  const tf = useT(formatEn, formatAr);
  const fmt = useFormat();
  const label = useLabel();
  const list = useCursorList(keys.assetPart(id, 'events'), (c) => fetchers.assetEvents(id, c));
  return (
    <Card flush>
      <CardHeader title={t('history')} />
      <QueryState query={list}>
        <DataTable<AssetEvent>
          rows={list.rows}
          rowKey={(e) => e.id}
          empty={t('nothingYet')}
          columns={[
            { key: 'when', header: t('col.when'), width: 170, cell: (e) => fmt.dateTime(e.occurredAt) },
            { key: 'what', header: t('col.what'), cell: (e) => eventText(e, { t: tf, fmt, label }) },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

function Documents({ id }: { id: string }) {
  const t = useT(en, ar);
  const { can } = usePermissions();
  const toast = useToast();
  const docs = useQuery({ queryKey: keys.documents({ assetId: id }), queryFn: () => fetchers.documents({ assetId: id }) });
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MaintenanceDocument['kind']>('manual');
  const add = useAction(
    (fileId: string) =>
      unwrap(api.POST('/api/v1/maintenance/documents', { body: { assetId: id, fileId, kind, title: title.trim() || t('documentDefault') } })),
    {
      invalidate: [keys.documents({ assetId: id })],
      onDone: () => {
        setTitle('');
        toast.show(t('documentAdded'));
      },
    },
  );
  const remove = useAction(
    (docId: string) => unwrap(api.POST('/api/v1/maintenance/documents/{id}/remove', { params: { path: { id: docId } } })),
    { invalidate: [keys.documents({ assetId: id })], onDone: () => toast.show(t('documentRemoved')) },
  );
  const kindText = (k: string) => ((DOC_KINDS as readonly string[]).includes(k) ? t(`doc.${k as (typeof DOC_KINDS)[number]}`) : k);
  return (
    <Card flush>
      <CardHeader title={t('documents')} />
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
                  <span className="t-secondary">· {kindText(d.kind)}</span>
                </span>
                {can('assets.manage') ? (
                  <Button size="sm" onClick={() => remove.mutate(d.id)}>
                    {t('remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </QueryState>
        {can('assets.manage') ? (
          <div className="form" style={{ marginTop: 12 }}>
            <div className="form__row">
              <Field label={t('docTitle')}>{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label={t('docKind')}>
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as MaintenanceDocument['kind'])}>
                    {DOC_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`doc.${k}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <FileUpload purpose="asset_document" label={t('addDocument')} disabled={add.isPending} onUploaded={(f) => add.mutateAsync(f).then(() => undefined)} />
            <ErrorAlert error={add.error} />
            <ErrorAlert error={remove.error} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Plans({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const list = useCursorList(keys.plans({ assetId: id }), (c) => fetchers.plans({ assetId: id }, c));
  return (
    <Card flush>
      <CardHeader title={t('plans')} />
      <QueryState query={list}>
        <DataTable<PlanSummary>
          rows={list.rows}
          rowKey={(p) => p.id}
          empty={t('noPlan')}
          columns={[
            {
              key: 't',
              header: t('col.plan'),
              cell: (p) => (
                <Link className="table__link" href={`/maintenance-plans/${p.id}`}>
                  {p.title}
                </Link>
              ),
            },
            { key: 'n', header: t('col.nextDue'), cell: (p) => (p.nextDueOn ? fmt.day(p.nextDueOn) : '—') },
            { key: 'a', header: t('col.status'), cell: (p) => (p.active ? t('on') : <Badge tone="beige">{t('off')}</Badge>) },
          ]}
        />
      </QueryState>
    </Card>
  );
}

export default function AssetPage() {
  const t = useT(en, ar);
  const tf = useT(formatEn, formatAr);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
    { ...refresh, onDone: done(t('outDone')) },
  );
  const back = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/assets/{id}/status', { params: { path: { id } }, body: { status: 'in_service' } })),
    { ...refresh, onDone: done(t('backDone')) },
  );
  const retire = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/assets/{id}/retire', { params: { path: { id } }, body: { reasonCode: reasonCode as (typeof REASON_CODES.assetRetire)[number] } })),
    { ...refresh, onDone: done(t('retired')) },
  );
  const move = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/assets/{id}/move', { params: { path: { id } }, body: { commonAreaId: to } })),
    { ...refresh, onDone: done(t('moved')) },
  );
  const tag = useAction(() => unwrap(api.POST('/api/v1/maintenance/assets/{id}/tag', { params: { path: { id } } })), {
    ...refresh,
    onDone: (x) => setCode(x.code),
  });
  const a = asset.data;
  const live = a && a.status !== 'retired';
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/assets" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('back')}
          </ButtonLink>
        }
        title={
          a ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="t-mono">{a.code}</span> {nameOf(fmt.locale, a)}
              <Badge tone={CONDITION_TONE[a.condition]}>{label(a.condition)}</Badge>
              {a.status !== 'in_service' ? <Badge tone="terracotta">{label(a.statusReason ?? a.status)}</Badge> : null}
              {a.health ? <Badge tone={HEALTH_TONE[a.health.band]}>{t('health', { score: fmt.number(a.health.score) })}</Badge> : null}
            </span>
          ) : (
            t('asset')
          )
        }
        description={
          a ? t('headline', { type: nameOf(fmt.locale, a.type), place: placeText(tf, fmt.locale, a), criticality: label(a.criticality) }) : undefined
        }
        actions={
          a && live && can('assets.manage') ? (
            <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button onClick={() => setOpen('edit')}>{t('edit')}</Button>
              {a.status === 'in_service' ? (
                <Button onClick={() => setOpen('out')}>{t('outOfService')}</Button>
              ) : (
                <Button loading={back.isPending} onClick={() => back.mutate()}>
                  {t('backInService')}
                </Button>
              )}
              {a.parentId === null ? <Button onClick={() => setOpen('move')}>{t('move')}</Button> : null}
              <Button loading={tag.isPending} onClick={() => tag.mutate()}>
                {a.tagIssuedAt ? t('newTag') : t('issueTag')}
              </Button>
              <Button variant="danger" onClick={() => setOpen('retire')}>
                {t('retire')}
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
              <AssetTimeline id={a.id} />
              <WarrantyClaims assetId={a.id} underWarranty={a.underWarranty} />
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
        title={t('outTitle')}
        codes={REASON_CODES.assetOutOfService}
        confirmLabel={t('outConfirm')}
        pending={out.isPending}
        error={<ErrorAlert error={out.error} />}
        onConfirm={(r) => out.mutate(r)}
      />
      <ReasonCodeDialog
        open={open === 'retire'}
        onClose={close}
        title={t('retireTitle')}
        description={t('retireDescription')}
        codes={REASON_CODES.assetRetire}
        confirmLabel={t('retire')}
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(r) => retire.mutate(r)}
      />
      <Dialog
        open={open === 'move'}
        onClose={close}
        title={t('moveTitle')}
        onSubmit={() => to && move.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={move.isPending} disabled={!to}>
              {t('move')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('moveTo')}>
            {(p) => (
              <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t('pickArea')}</option>
                {(areas.data?.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} · {nameOf(fmt.locale, x)}
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
