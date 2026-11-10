'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Textarea,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Back, FacilityBadges, useLocalName } from '@/components/facilities/bits';
import { Closures } from '@/components/facilities/closures';
import { Fees, StayRules } from '@/components/facilities/fees';
import { Rules } from '@/components/facilities/rules';
import { WeeklyWindows } from '@/components/facilities/weekly-windows';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Facility } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';

const TABS = ['details', 'rules', 'stay', 'fees', 'hours', 'peaks', 'closures'] as const;
type Tab = (typeof TABS)[number];

function Details({ facility }: { facility: Facility }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
    onDone: () => toast.show(c('saved')),
  });
  const text = (key: keyof typeof form, label: string, opts: { ar?: boolean; en?: boolean; long?: boolean; hint?: string } = {}) => {
    const dir = opts.ar ? 'rtl' : opts.en ? 'ltr' : undefined;
    return (
      <Field label={label} hint={opts.hint} error={fieldError(save.error, key)}>
        {(p) =>
          opts.long ? (
            <Textarea {...p} rows={3} maxLength={1000} dir={dir} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          ) : (
            <Input {...p} maxLength={80} dir={dir} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          )
        }
      </Field>
    );
  };
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
        <CardHeader title={t('whatResidentsRead')} />
        <CardBody>
          <div className="form">
            {text('nameEn', t('nameEn'), { en: true })}
            {text('nameAr', t('nameAr'), { ar: true })}
            {text('descriptionEn', t('descriptionEn'), { long: true, en: true, hint: t('optional') })}
            {text('descriptionAr', t('descriptionAr'), { long: true, ar: true, hint: t('optional') })}
            {text('position', t('position'), { hint: t('positionHint') })}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !ready}>
          {c('save')}
        </Button>
      </span>
    </form>
  );
}

function FacilityView() {
  const t = useT(en, ar);
  const name = useLocalName();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const canManage = can('facilities.manage');
  const allowed = canManage || can('bookings.handle');
  const [tab, setTab] = useTab(TABS, canManage ? 'details' : 'closures');
  const facility = useQuery({ queryKey: keys.facility(id), queryFn: () => fetchers.facility(id), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/facilities" label={t('title')} />} title={t('facility')} />
        <ForbiddenState />
      </>
    );
  const f = facility.data;
  const bookable = f?.mode === 'bookable';
  const stay = f?.mode === 'stay';
  const shown: Tab = !canManage
    ? 'closures'
    : (!bookable && (tab === 'rules' || tab === 'peaks')) || (!stay && tab === 'stay') || (f?.mode === 'walk_in' && tab === 'fees')
      ? 'details'
      : tab;
  const tabs: Tab[] = [
    'details',
    ...(bookable ? (['rules'] as const) : []),
    ...(stay ? (['stay'] as const) : []),
    ...(bookable || stay ? (['fees'] as const) : []),
    'hours',
    ...(bookable ? (['peaks'] as const) : []),
    'closures',
  ];

  return (
    <>
      <PageHeader
        back={<Back href="/facilities" label={t('title')} />}
        title={f ? name(f) : t('facility')}
        description={f ? <FacilityBadges facility={f} /> : undefined}
        actions={bookable ? <ButtonLink href={`/bookings?facility=${id}`}>{t('dayView')}</ButtonLink> : undefined}
      />
      <QueryState query={facility}>
        {f ? (
          <>
            {canManage ? (
              <div className="toolbar" style={{ overflowX: 'auto' }}>
                <Segmented<Tab>
                  label={t('facility')}
                  value={shown}
                  onChange={setTab}
                  options={tabs.map((v) => ({ value: v, label: t(`tab.${v}`) }))}
                />
              </div>
            ) : null}
            {!f.active ? <Alert tone="warn">{t('retiredAlert')}</Alert> : null}
            {shown === 'details' ? <Details key={f.updatedAt} facility={f} /> : null}
            {shown === 'rules' && f.rules ? <Rules key={f.updatedAt} facility={f} rules={f.rules} /> : null}
            {shown === 'stay' && f.stay ? <StayRules key={`stay-${f.updatedAt}`} facility={f} /> : null}
            {shown === 'fees' && f.fees ? <Fees key={`fees-${f.updatedAt}`} facility={f} /> : null}
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
