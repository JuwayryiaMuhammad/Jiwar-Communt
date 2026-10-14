'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Button, ButtonLink, Card, CardBody, CardHeader, Field, ForbiddenState, Input, PageHeader, Segmented, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Back, FacilityBadges } from '@/components/facilities/bits';
import { Closures } from '@/components/facilities/closures';
import { Rules } from '@/components/facilities/rules';
import { WeeklyWindows } from '@/components/facilities/weekly-windows';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Facility } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['details', 'rules', 'hours', 'peaks', 'closures'] as const;
type Tab = (typeof TABS)[number];

function Details({ facility }: { facility: Facility }) {
  const toast = useToast();
  const [form, setForm] = useState({
    nameEn: facility.nameEn,
    nameAr: facility.nameAr,
    descriptionEn: facility.descriptionEn ?? '',
    descriptionAr: facility.descriptionAr ?? '',
    position: String(facility.position),
  });
  const body = {
    ...(form.nameEn.trim() !== facility.nameEn ? { nameEn: form.nameEn.trim() } : {}),
    ...(form.nameAr.trim() !== facility.nameAr ? { nameAr: form.nameAr.trim() } : {}),
    ...(form.descriptionEn.trim() !== (facility.descriptionEn ?? '') ? { descriptionEn: form.descriptionEn.trim() || null } : {}),
    ...(form.descriptionAr.trim() !== (facility.descriptionAr ?? '') ? { descriptionAr: form.descriptionAr.trim() || null } : {}),
    ...(Number(form.position) !== facility.position ? { position: Number(form.position) } : {}),
  };
  const ready = form.nameEn.trim() !== '' && form.nameAr.trim() !== '' && /^\d{1,4}$/.test(form.position) && Number(form.position) <= 1000;
  const dirty = Object.keys(body).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: facility.id } }, body })), {
    invalidate: [keys.facilitiesAll],
    onDone: () => toast.show('Saved.'),
  });
  const text = (key: keyof typeof form, label: string, opts: { ar?: boolean; long?: boolean; hint?: string } = {}) => (
    <Field label={label} hint={opts.hint} error={fieldError(save.error, key)}>
      {(p) =>
        opts.long ? (
          <Textarea {...p} rows={3} maxLength={1000} dir={opts.ar ? 'rtl' : undefined} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        ) : (
          <Input {...p} maxLength={80} dir={opts.ar ? 'rtl' : undefined} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        )
      }
    </Field>
  );
  return (
    <form
      className="stack"
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && ready) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title="What residents read" />
        <CardBody>
          <div className="form">
            {text('nameEn', 'Name in English')}
            {text('nameAr', 'Name in Arabic', { ar: true })}
            {text('descriptionEn', 'Description in English', { long: true, hint: 'Optional.' })}
            {text('descriptionAr', 'Description in Arabic', { long: true, ar: true, hint: 'Optional.' })}
            {text('position', 'Order in the list', { hint: 'Lower first, from 0 to 1000.' })}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !ready}>
          Save
        </Button>
      </span>
    </form>
  );
}

function FacilityView() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const canManage = can('facilities.manage');
  const allowed = canManage || can('bookings.handle');
  const [tab, setTab] = useTab(TABS, canManage ? 'details' : 'closures');
  const facility = useQuery({ queryKey: keys.facility(id), queryFn: () => fetchers.facility(id), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/facilities" label="Facilities" />} title="Facility" />
        <ForbiddenState />
      </>
    );
  const f = facility.data;
  const bookable = f?.mode === 'bookable';
  const shown: Tab = !canManage ? 'closures' : !bookable && (tab === 'rules' || tab === 'peaks') ? 'details' : tab;

  return (
    <>
      <PageHeader
        back={<Back href="/facilities" label="Facilities" />}
        title={f ? f.nameEn : 'Facility'}
        description={f ? <FacilityBadges facility={f} /> : undefined}
        actions={
          bookable ? (
            <ButtonLink href={`/bookings?facility=${id}`}>Day view</ButtonLink>
          ) : undefined
        }
      />
      <QueryState query={facility}>
        {f ? (
          <>
            {canManage ? (
              <div className="toolbar" style={{ overflowX: 'auto' }}>
                <Segmented<Tab>
                  label="Facility"
                  value={shown}
                  onChange={setTab}
                  options={[
                    { value: 'details', label: 'Details' },
                    ...(bookable ? [{ value: 'rules' as const, label: 'Rules' }] : []),
                    { value: 'hours', label: 'Opening hours' },
                    ...(bookable ? [{ value: 'peaks' as const, label: 'Peak times' }] : []),
                    { value: 'closures', label: 'Closures' },
                  ]}
                />
              </div>
            ) : null}
            {!f.active ? <Alert tone="warn">Retired: residents do not see it and it takes no new booking. Bookings already made stay.</Alert> : null}
            {shown === 'details' ? <Details key={f.updatedAt} facility={f} /> : null}
            {shown === 'rules' && f.rules ? <Rules key={f.updatedAt} facility={f} rules={f.rules} /> : null}
            {shown === 'hours' ? <WeeklyWindows key={`hours-${f.updatedAt}`} facility={f} kind="hours" /> : null}
            {shown === 'peaks' ? <WeeklyWindows key={`peaks-${f.updatedAt}`} facility={f} kind="peaks" /> : null}
            {shown === 'closures' ? <Closures facility={f} canManage={canManage} /> : null}
          </>
        ) : null}
      </QueryState>
    </>
  );
}

export default function FacilityPage() {
  return (
    <Suspense>
      <FacilityView />
    </Suspense>
  );
}
