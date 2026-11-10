'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/services-message-templates';
import en from '@/messages/en/services-message-templates';

type Kind = 'announcement' | 'reply';
interface Template {
  id: string;
  name: string;
  titleEn?: string | null;
  bodyEn: string | null;
  bodyAr: string | null;
  topicId?: string | null;
}

const PATHS = {
  announcement: '/api/v1/community/announcement-templates',
  reply: '/api/v1/management/reply-templates',
} as const;

/**
 * The compound's message templates (ADR 0080): announcements' (copied into
 * a new draft) and the queue's replies (picked when answering a request).
 * Nothing points back at a template: it is changed and deleted freely.
 */
export default function MessageTemplatesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const { can } = usePermissions();
  const toast = useToast();
  const mayAnnounce = can('community.publish');
  const mayReply = can('requests.manage');
  const [kind, setKind] = useState<Kind>(mayAnnounce ? 'announcement' : 'reply');
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const key = ['message-templates', kind];
  const list = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET(PATHS[kind] as never)) as Promise<{ data: Template[] }>,
    enabled: mayAnnounce || mayReply,
  });
  const save = useAction(
    () => {
      const tpl = editing!;
      const body =
        kind === 'announcement'
          ? { name: tpl.name, titleEn: tpl.titleEn || null, bodyEn: tpl.bodyEn || null }
          : { name: tpl.name, bodyEn: tpl.bodyEn || null, bodyAr: tpl.bodyAr || null };
      return tpl.id
        ? unwrap(api.PATCH(`${PATHS[kind]}/{id}` as never, { params: { path: { id: tpl.id } }, body } as never))
        : unwrap(api.POST(PATHS[kind] as never, { body } as never));
    },
    {
      invalidate: [key],
      onDone: () => {
        toast.show(t('saved'));
        setEditing(null);
      },
    },
  );
  const remove = useAction((id: string) => unwrap(api.DELETE(`${PATHS[kind]}/{id}` as never, { params: { path: { id } } } as never)), {
    invalidate: [key],
    onDone: () => toast.show(t('deleted')),
  });
  if (!mayAnnounce && !mayReply) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setEditing({})}>
            {t('newTemplate')}
          </Button>
        }
      />
      {mayAnnounce && mayReply ? (
        <div className="toolbar">
          <Segmented<Kind>
            label={t('shown')}
            value={kind}
            onChange={setKind}
            options={(['announcement', 'reply'] as const).map((value) => ({ value, label: t(`kind.${value}`) }))}
          />
        </div>
      ) : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable
            rows={list.data?.data ?? []}
            rowKey={(row) => row.id}
            columns={[
              { key: 'name', header: t('col.name'), cell: (row) => row.name },
              { key: 'words', header: t('col.words'), cell: (row) => (row.bodyEn ?? row.bodyAr ?? '').slice(0, 80) },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="row">
                    <Button onClick={() => setEditing(row)}>{c('edit')}</Button>
                    <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(row.id)}>
                      {c('delete')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('editTitle') : t('newTemplate')}
        onSubmit={() => editing?.name && save.mutate()}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!editing?.name}>
              {c('save')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('name')} hint={t('nameHint')}>
            {(p) => <Input {...p} maxLength={80} value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}
          </Field>
          {kind === 'announcement' ? (
            <Field label={t('titleEn')}>
              {(p) => <Input {...p} maxLength={150} dir="ltr" lang="en" value={editing?.titleEn ?? ''} onChange={(e) => setEditing({ ...editing, titleEn: e.target.value })} />}
            </Field>
          ) : null}
          <Field label={t('wordsEn')}>
            {(p) => <Textarea {...p} rows={4} dir="ltr" lang="en" value={editing?.bodyEn ?? ''} onChange={(e) => setEditing({ ...editing, bodyEn: e.target.value })} />}
          </Field>
          {kind === 'reply' ? (
            <Field label={t('wordsAr')}>
              {(p) => <Textarea {...p} rows={4} dir="rtl" value={editing?.bodyAr ?? ''} onChange={(e) => setEditing({ ...editing, bodyAr: e.target.value })} />}
            </Field>
          ) : null}
          <ErrorAlert error={save.error ?? remove.error} />
        </div>
      </Dialog>
    </>
  );
}
