'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CATEGORIES, CATEGORY_TEXT } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerCategory, type PartnerSettings, type PartnerSubcategory } from '@/lib/queries';

const RANGES = {
  newDays: { min: 1, max: 90, label: 'New for, days', hint: 'A partner is shown as new this long after it was listed.' },
  lateFromMinute: { min: 960, max: 1439, label: '“Open late” from, minute of the day', hint: '1320 is 22:00.' },
  maxLiveRequests: { min: 1, max: 20, label: 'Open requests per resident', hint: 'Pending, proposed or accepted at once.' },
  ratingDays: { min: 1, max: 60, label: 'Rating window, days', hint: 'After a request is done.' },
  complaintDays: { min: 1, max: 60, label: 'Complaint window, days', hint: 'After a request ends.' },
  deskLinkDays: { min: 7, max: 365, label: 'Desk links work for, days', hint: 'Then the management makes a new one.' },
} as const;
type Key = keyof typeof RANGES;
const KEYS = Object.keys(RANGES) as Key[];
type Form = Record<Key, string>;
const toForm = (s: PartnerSettings): Form => Object.fromEntries(KEYS.map((k) => [k, String(s[k])])) as Form;
const inRange = (k: Key, v: string) => /^\d+$/.test(v) && Number(v) >= RANGES[k].min && Number(v) <= RANGES[k].max;

function Settings() {
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
      toast.show('Partner settings saved.');
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
        <CardHeader title="Settings" />
        <CardBody>
          <div className="form">
            {KEYS.map((k) => (
              <Field
                key={k}
                label={RANGES[k].label}
                hint={`${RANGES[k].hint} From ${RANGES[k].min} to ${RANGES[k].max}.`}
                error={fieldError(save.error, k) ?? (inRange(k, form[k]) ? undefined : `A whole number from ${RANGES[k].min} to ${RANGES[k].max}.`)}
              >
                {(p) => <Input {...p} type="number" min={RANGES[k].min} max={RANGES[k].max} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
              </Field>
            ))}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          Save
        </Button>
      </span>
    </form>
  );
}

function NewSubcategory({ onClose }: { onClose: () => void }) {
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
        toast.show('Sub-category added.');
        onClose();
      },
    },
  );
  const ready = /^[a-z][a-z0-9_]{1,39}$/.test(key.trim()) && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title="New sub-category"
      description="Its key and category never change; its names may."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Category">
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as PartnerCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_TEXT[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Key" hint="Lower case letters, digits and _, e.g. window_cleaning." error={fieldError(save.error, 'key')}>
          {(p) => <Input {...p} value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label="Name in English" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Subcategories() {
  const toast = useToast();
  const subs = useQuery({ queryKey: keys.partnerSubcategories, queryFn: fetchers.partnerSubcategories });
  const [adding, setAdding] = useState(false);
  const toggle = useAction(
    (s: PartnerSubcategory) =>
      unwrap(api.PATCH('/api/v1/staff/partner-subcategories/{id}', { params: { path: { id: s.id } }, body: { active: !s.active } })),
    { invalidate: [keys.partnerSubcategories], onDone: (s) => toast.show(s.active ? 'Restored.' : 'Retired: offered for nothing new.') },
  );
  return (
    <Card flush>
      <CardHeader
        title="Sub-categories"
        actions={
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            Add
          </Button>
        }
      />
      <QueryState query={subs}>
        <DataTable<PartnerSubcategory>
          rows={subs.data?.data ?? []}
          rowKey={(s) => s.id}
          empty="None"
          columns={[
            { key: 'c', header: 'Category', cell: (s) => CATEGORY_TEXT[s.category] ?? s.category },
            { key: 'n', header: 'Name', cell: (s) => `${s.nameEn} · ${s.nameAr}` },
            { key: 'k', header: 'Key', cell: (s) => <span className="t-mono">{s.key}</span> },
            {
              key: 'a',
              header: '',
              cell: (s) => (
                <Button size="sm" variant="text" loading={toggle.isPending} onClick={() => toggle.mutate(s)}>
                  {s.active ? 'Retire' : 'Restore'}
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
  const { ready, can } = usePermissions();
  if (ready && !can('partners.manage'))
    return (
      <>
        <PageHeader title="Partner settings" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Partner settings" description="How long a partner is new, when “open late” starts, the residents’ limits and windows, and the desk links’ life." />
      <div className="stack">
        <Settings />
        <Subcategories />
      </div>
    </>
  );
}
