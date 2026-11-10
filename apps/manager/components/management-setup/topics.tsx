'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useLocale, useT, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { localName } from '@/components/management-requests/logic';
import { fetchers, keys, type RequestTopic } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-setup';
import en from '@/messages/en/services-mgmt-setup';

const HOURS = { min: 1, max: 720 };
const validHours = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= HOURS.min && n <= HOURS.max;
};

/** "48 hours (2 days)", in the page's language. */
export function targetText(t: Translate<typeof en>, hours: number): string {
  const days = hours / 24;
  const text = t('target.hours', { n: hours });
  return hours >= 24 && Number.isInteger(days) ? t('target.both', { hours: text, days: t('target.days', { n: days }) }) : text;
}

function TopicDialog({ topic, open, onClose }: { topic: RequestTopic | null; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const [names, setNames] = useState<Names>(topic ? { key: topic.key, nameEn: topic.nameEn, nameAr: topic.nameAr } : NO_NAMES);
  const [hours, setHours] = useState(topic ? String(topic.targetResponseHours) : '48');
  const [active, setActive] = useState(topic?.active ?? true);
  // The role whose handlers answer it (ADR 0058): a staff or manager role.
  const [owner, setOwner] = useState(topic?.ownerRoleId ?? '');
  const roles = useQuery({ queryKey: keys.roles, queryFn: fetchers.roles, enabled: !!topic });
  const save = useAction(
    () =>
      topic
        ? unwrap(
            api.PATCH('/api/v1/management/request-topics/{id}', {
              params: { path: { id: topic.id } },
              body: {
                nameEn: names.nameEn.trim(),
                nameAr: names.nameAr.trim(),
                targetResponseHours: Number(hours),
                active,
                ownerRoleId: owner || null,
              },
            }),
          )
        : unwrap(
            api.POST('/api/v1/management/request-topics', {
              body: { key: names.key, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), targetResponseHours: Number(hours) },
            }),
          ),
    {
      invalidate: [keys.requestTopics, keys.requestTopicOptions],
      onDone: (saved) => {
        toast.show(t('topicSaved', { name: localName(locale, saved) }));
        onClose();
      },
    },
  );
  const ready = namesReady(names, !topic) && validHours(hours);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={topic ? t('editTopic', { name: localName(locale, topic) }) : t('newTopic')}
      description={t('topicDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!topic} example="parking" />
        <Field
          label={t('targetLabel')}
          hint={t('targetHint')}
          error={fieldError(save.error, 'targetResponseHours') ?? (hours !== '' && !validHours(hours) ? t('wholeNumber', { min: HOURS.min, max: HOURS.max }) : undefined)}
        >
          {(p) => <Input {...p} type="number" min={HOURS.min} max={HOURS.max} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />}
        </Field>
        {topic ? (
          <Field
            label={t('answeredBy')}
            hint={t('answeredByHint')}
            error={fieldError(save.error, 'ownerRoleId')}
          >
            {(p) => (
              <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">{t('everyHandler')}</option>
                {(roles.data?.data ?? [])
                  .filter((r) => r.kind === 'staff' || r.kind === 'manager')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name ?? r.key}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        {topic ? (
          <Checkbox
            label={t('offered')}
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { topic: RequestTopic | null } | null;

/** The compound's request topics and their response targets (ADR 0039). */
export function Topics() {
  const t = useT(en, ar);
  const c = useCommonT();
  const topics = useQuery({ queryKey: keys.requestTopics, queryFn: fetchers.requestTopics });
  const [open, setOpen] = useState<Open>(null);

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ topic: null })}>
          {t('newTopic')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={topics}>
          <DataTable<RequestTopic>
            rows={topics.data?.data}
            rowKey={(row) => row.id}
            empty={t('topicsEmpty')}
            emptyHint={t('topicsEmptyHint')}
            columns={[
              {
                key: 'name',
                header: t('col.topic'),
                cell: (row) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary" dir="ltr" lang="en">
                      {row.nameEn}
                    </span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {row.nameAr}
                    </span>
                    {!row.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: t('col.code'), cell: (row) => <span className="t-mono">{row.key}</span> },
              { key: 'target', header: t('col.target'), cell: (row) => targetText(t, row.targetResponseHours) },
              {
                key: 'owner',
                header: t('answeredBy'),
                cell: (row) => (row.owner ? (row.owner.roleName ?? row.owner.roleKey) : t('everyHandler')),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (row) => (
                  <Button size="sm" onClick={() => setOpen({ topic: row })}>
                    {c('edit')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {/* Remounted per topic, so the form starts from the row that was opened. */}
      {open ? <TopicDialog key={open.topic?.id ?? 'new'} topic={open.topic} open onClose={() => setOpen(null)} /> : null}
    </>
  );
}
