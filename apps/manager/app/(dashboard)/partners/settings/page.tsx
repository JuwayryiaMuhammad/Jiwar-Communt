'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CATEGORIES, word } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerCategory, type PartnerSettings, type PartnerSubcategory } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-settings';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-settings';

const RANGES = {
  newDays: { min: 1, max: 90 },
  lateFromMinute: { min: 960, max: 1439 },
  maxLiveRequests: { min: 1, max: 20 },
  ratingDays: { min: 1, max: 60 },
  complaintDays: { min: 1, max: 60 },
  deskLinkDays: { min: 7, max: 365 },
} as const;
type Key = keyof typeof RANGES;
const KEYS = Object.keys(RANGES) as Key[];
type Form = Record<Key, string>;
const toForm = (s: PartnerSettings): Form => Object.fromEntries(KEYS.map((k) => [k, String(s[k])])) as Form;
const inRange = (k: Key, v: string) => /^\d+$/.test(v) && Number(v) >= RANGES[k].min && Number(v) <= RANGES[k].max;

function Settings() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.partnerSettings, queryFn: fetchers.partnerSettings });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);
  const saved = settings.data;
  const invalid = form ? KEYS.some((k) => !inRange(k, form[k])) : true;
  const changes = saved && form && !invalid ? Object.fromEntries(KEYS.filter((k) => Number(form[k]) !== saved[k]).map((k) => [k, Number(form[k])])) : {};
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/partner-settings', { body: changes })), {
    invalidate: [keys.partnerSettings],
    onDone: (next) => {
      setForm(toForm(next));
      toast.show(t('saved'));
    },
  });
  if (!form || !saved) return <QueryState query={settings}>{null}</QueryState>;
  return (
    <form
      className="stack"
      style={{ maxWidth: 560 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('settings')} />
        <CardBody>
          <div className="form">
            {KEYS.map((k) => (
              <Field
                key={k}
                label={t(`${k}.label`)}
                hint={t('range', { hint: t(`${k}.hint`), min: f.number(RANGES[k].min), max: f.number(RANGES[k].max) })}
                error={
                  fieldError(save.error, k) ??
                  (inRange(k, form[k]) ? undefined : t('rangeError', { min: f.number(RANGES[k].min), max: f.number(RANGES[k].max) }))
                }
              >
                {(p) => <Input {...p} className="ltr" type="number" min={RANGES[k].min} max={RANGES[k].max} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
              </Field>
            ))}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          {c('save')}
        </Button>
      </span>
    </form>
  );
}

function NewSubcategory({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const toast = useToast();
  const [category, setCategory] = useState<PartnerCategory>('home_services');
  const [key, setKey] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/partner-subcategories', { body: { category, key: key.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim() } })),
    {
      invalidate: [keys.partnerSubcategories],
      onDone: () => {
        toast.show(t('new.added'));
        onClose();
      },
    },
  );
  const ready = /^[a-z][a-z0-9_]{1,39}$/.test(key.trim()) && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('new.title')}
      description={t('new.description')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('category')}>
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as PartnerCategory)}>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {word(codes, 'category', cat)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('key')} hint={t('keyHint')} error={fieldError(save.error, 'key')}>
          {(p) => <Input {...p} className="ltr" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Subcategories() {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const subs = useQuery({ queryKey: keys.partnerSubcategories, queryFn: fetchers.partnerSubcategories });
  const [adding, setAdding] = useState(false);
  const toggle = useAction(
    (s: PartnerSubcategory) =>
      unwrap(api.PATCH('/api/v1/staff/partner-subcategories/{id}', { params: { path: { id: s.id } }, body: { active: !s.active } })),
    { invalidate: [keys.partnerSubcategories], onDone: (s) => toast.show(s.active ? t('restored') : t('retired')) },
  );
  return (
    <Card flush>
      <CardHeader
        title={t('subcategories')}
        actions={
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            {c('add')}
          </Button>
        }
      />
      <QueryState query={subs}>
        <DataTable<PartnerSubcategory>
          rows={subs.data?.data ?? []}
          rowKey={(s) => s.id}
          empty={t('none')}
          columns={[
            { key: 'c', header: t('col.category'), cell: (s) => word(codes, 'category', s.category) },
            { key: 'n', header: t('col.name'), cell: (s) => (locale === 'ar' ? `${s.nameAr} · ${s.nameEn}` : `${s.nameEn} · ${s.nameAr}`) },
            { key: 'k', header: t('col.key'), cell: (s) => <span className="t-mono ltr">{s.key}</span> },
            {
              key: 'a',
              header: '',
              cell: (s) => (
                <Button size="sm" variant="text" loading={toggle.isPending} onClick={() => toggle.mutate(s)}>
                  {s.active ? t('retire') : t('restore')}
                </Button>
              ),
            },
          ]}
        />
      </QueryState>
      <ErrorAlert error={toggle.error} />
      {adding ? <NewSubcategory onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

/** The compound's partner settings and sub-categories (ADR 0060). */
export default function PartnerSettingsPage() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  if (ready && !can('partners.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Settings />
        <Subcategories />
      </div>
    </>
  );
}
