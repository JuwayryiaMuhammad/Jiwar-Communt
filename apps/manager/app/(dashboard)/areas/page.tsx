'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { TagDialog } from '@/components/assets/tag-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CommonArea } from '@/lib/queries';
import ar from '@/messages/ar/fac-areas';
import en from '@/messages/en/fac-areas';

type Kind = CommonArea['kind'];

function AreaDialog({ area, onClose }: { area: CommonArea | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(area?.kind ?? 'area');
  const [code, setCode] = useState(area?.code ?? '');
  const [nameEn, setNameEn] = useState(area?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(area?.nameAr ?? '');
  const [building, setBuilding] = useState(area?.building ?? '');
  const [facilityId, setFacilityId] = useState(area?.facilityId ?? '');
  const [active, setActive] = useState(area?.active ?? true);
  const save = useAction(
    () =>
      area
        ? unwrap(
            api.PATCH('/api/v1/maintenance/areas/{id}', {
              params: { path: { id: area.id } },
              body: {
                nameEn: nameEn.trim(),
                nameAr: nameAr.trim(),
                ...(area.kind === 'area' ? { building: building.trim() || null } : {}),
                active,
              },
            }),
          )
        : unwrap(
            api.POST('/api/v1/maintenance/areas', {
              body: {
                kind,
                code: code.trim(),
                nameEn: nameEn.trim(),
                nameAr: nameAr.trim(),
                ...(kind !== 'facility' && building.trim() ? { building: building.trim() } : {}),
                ...(kind === 'facility' ? { facilityId } : {}),
              },
            }),
          ),
    {
      invalidate: [keys.assetsAll],
      onDone: (saved) => {
        toast.show(t('saved', { name: saved.nameEn }));
        onClose();
      },
    },
  );
  const ready =
    nameEn.trim() !== '' &&
    nameAr.trim() !== '' &&
    (area !== null || (code.trim() !== '' && (kind !== 'building' || building.trim() !== '') && (kind !== 'facility' || facilityId !== '')));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={area ? t('editTitle', { code: area.code }) : t('newTitle')}
      description={area ? undefined : t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {area ? c('save') : t('addArea')}
          </Button>
        </>
      }
    >
      <div className="form">
        {area ? null : (
          <div className="form__row">
            <Field label={c('kind')}>
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="area">{t('kind.area')}</option>
                  <option value="building">{t('option.building')}</option>
                  <option value="facility">{t('kind.facility')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('col.code')} hint={t('codeHint')} error={fieldError(save.error, 'code')}>
              {(p) => <Input {...p} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />}
            </Field>
          </div>
        )}
        <div className="form__row">
          <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        {(area ? area.kind === 'area' : kind !== 'facility') ? (
          <Field
            label={t('col.building')}
            hint={kind === 'building' ? t('buildingHintBuilding') : t('buildingHintArea')}
            error={fieldError(save.error, 'building')}
          >
            {(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}
          </Field>
        ) : null}
        {!area && kind === 'facility' ? (
          <Field label={t('facilityId')} hint={t('facilityIdHint')} error={fieldError(save.error, 'facilityId')}>
            {(p) => <Input {...p} className="t-mono" dir="ltr" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} />}
          </Field>
        ) : null}
        {area ? (
          <Checkbox
            label={t('inUse')}
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The compound's common areas (ADR 0064). */
export default function AreasPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [kind, setKind] = useState<Kind | ''>('');
  const [open, setOpen] = useState<CommonArea | 'new' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const filters = { kind };
  const list = useCursorList(keys.areas(filters), (cursor) => fetchers.areas(filters, cursor), { enabled: can('assets.read') });
  const tag = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/areas/{id}/tag', { params: { path: { id } } })),
    {
      invalidate: [keys.assetsAll],
      onDone: (issued) => {
        setCode(issued.code);
        toast.show(t('tagToast'));
      },
    },
  );
  if (ready && !can('assets.read'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('assets.manage') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
              {t('newArea')}
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Kind | ''>
          label={c('kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: c('all') },
            { value: 'building', label: t('kinds.building') },
            { value: 'area', label: t('kinds.area') },
            { value: 'facility', label: t('kinds.facility') },
          ]}
        />
      </div>
      <ErrorAlert error={tag.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<CommonArea>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              { key: 'code', header: t('col.code'), cell: (a) => <span className="t-mono ltr">{a.code}</span> },
              {
                key: 'name',
                header: t('col.name'),
                cell: (a) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{a.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {a.nameAr}
                    </span>
                    {!a.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (a) => t(`kind.${a.kind}`) },
              { key: 'building', header: t('col.building'), cell: (a) => a.building ?? '—' },
              { key: 'tag', header: t('col.tag'), cell: (a) => (a.tagIssuedAt ? t('tagIssued') : <span className="t-secondary">{t('tagNone')}</span>) },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (a) =>
                  can('assets.manage') ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setOpen(a)}>
                        {c('edit')}
                      </Button>
                      {a.active ? (
                        <Button size="sm" loading={tag.isPending} onClick={() => tag.mutate(a.id)}>
                          {a.tagIssuedAt ? t('newTag') : t('issueTag')}
                        </Button>
                      ) : null}
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <AreaDialog area={open === 'new' ? null : open} onClose={() => setOpen(null)} /> : null}
      <TagDialog code={code} onClose={() => setCode(null)} />
    </>
  );
}
