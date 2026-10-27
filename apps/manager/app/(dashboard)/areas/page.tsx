'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { TagDialog } from '@/components/assets/tag-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CommonArea } from '@/lib/queries';

type Kind = CommonArea['kind'];

const KIND_TEXT: Record<Kind, string> = { building: 'Building', area: 'Area', facility: 'Facility' };

function AreaDialog({ area, onClose }: { area: CommonArea | null; onClose: () => void }) {
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
        toast.show(`${saved.nameEn} is saved.`);
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
      title={area ? `Edit ${area.code}` : 'New common area'}
      description={area ? undefined : 'A place of the compound that is not a unit: a building as a whole, a garden, a roof, a pump room, or a facility.'}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {area ? 'Save' : 'Add area'}
          </Button>
        </>
      }
    >
      <div className="form">
        {area ? null : (
          <div className="form__row">
            <Field label="Kind">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="area">Area</option>
                  <option value="building">Building (as a whole)</option>
                  <option value="facility">Facility</option>
                </Select>
              )}
            </Field>
            <Field label="Code" hint="Short and unique, e.g. PR-1. Never changes." error={fieldError(save.error, 'code')}>
              {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} />}
            </Field>
          </div>
        )}
        <div className="form__row">
          <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        {(area ? area.kind === 'area' : kind !== 'facility') ? (
          <Field
            label="Building"
            hint={kind === 'building' ? 'As the units have it.' : 'Where the area is, when it is in a building.'}
            error={fieldError(save.error, 'building')}
          >
            {(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}
          </Field>
        ) : null}
        {!area && kind === 'facility' ? (
          <Field label="Facility id" hint="The facility this area is." error={fieldError(save.error, 'facilityId')}>
            {(p) => <Input {...p} className="t-mono" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} />}
          </Field>
        ) : null}
        {area ? (
          <Checkbox
            label="In use. Unticked retires it: nothing new goes there"
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
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [kind, setKind] = useState<Kind | ''>('');
  const [open, setOpen] = useState<CommonArea | 'new' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const filters = { kind };
  const list = useCursorList(keys.areas(filters), (c) => fetchers.areas(filters, c), { enabled: can('assets.read') });
  const tag = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/areas/{id}/tag', { params: { path: { id } } })),
    {
      invalidate: [keys.assetsAll],
      onDone: (t) => {
        setCode(t.code);
        toast.show('Tag issued.');
      },
    },
  );
  if (ready && !can('assets.read'))
    return (
      <>
        <PageHeader title="Common areas" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Common areas"
        description="Where an asset is when it is not in a unit, and what an inspection walks."
        actions={
          can('assets.manage') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
              New area
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Kind | ''>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: 'All' },
            { value: 'building', label: 'Buildings' },
            { value: 'area', label: 'Areas' },
            { value: 'facility', label: 'Facilities' },
          ]}
        />
      </div>
      <ErrorAlert error={tag.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<CommonArea>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="No common area yet"
            emptyHint="Add the buildings, gardens and plant rooms that hold the compound's equipment."
            columns={[
              { key: 'code', header: 'Code', cell: (a) => <span className="t-mono">{a.code}</span> },
              {
                key: 'name',
                header: 'Name',
                cell: (a) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{a.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {a.nameAr}
                    </span>
                    {!a.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (a) => KIND_TEXT[a.kind] },
              { key: 'building', header: 'Building', cell: (a) => a.building ?? '—' },
              { key: 'tag', header: 'Tag', cell: (a) => (a.tagIssuedAt ? 'Issued' : <span className="t-secondary">None</span>) },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (a) =>
                  can('assets.manage') ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setOpen(a)}>
                        Edit
                      </Button>
                      {a.active ? (
                        <Button size="sm" loading={tag.isPending} onClick={() => tag.mutate(a.id)}>
                          {a.tagIssuedAt ? 'New tag' : 'Issue tag'}
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
