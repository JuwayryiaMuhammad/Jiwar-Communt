'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

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
      const t = editing!;
      const body =
        kind === 'announcement'
          ? { name: t.name, titleEn: t.titleEn || null, bodyEn: t.bodyEn || null }
          : { name: t.name, bodyEn: t.bodyEn || null, bodyAr: t.bodyAr || null };
      return t.id
        ? unwrap(api.PATCH(`${PATHS[kind]}/{id}` as never, { params: { path: { id: t.id } }, body } as never))
        : unwrap(api.POST(PATHS[kind] as never, { body } as never));
    },
    {
      invalidate: [key],
      onDone: () => {
        toast.show('The template is saved.');
        setEditing(null);
      },
    },
  );
  const remove = useAction((id: string) => unwrap(api.DELETE(`${PATHS[kind]}/{id}` as never, { params: { path: { id } } } as never)), {
    invalidate: [key],
    onDone: () => toast.show('The template is deleted.'),
  });
  if (!mayAnnounce && !mayReply) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Message templates"
        description="Words the office writes often, kept once. Announcement templates start a new draft; reply templates are picked when answering a request."
        actions={
          <Button variant="primary" onClick={() => setEditing({})}>
            New template
          </Button>
        }
      />
      {mayAnnounce && mayReply ? (
        <div className="toolbar">
          <Segmented<Kind>
            label="Templates shown"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'announcement', label: 'Announcements' },
              { value: 'reply', label: 'Replies' },
            ]}
          />
        </div>
      ) : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable
            rows={list.data?.data ?? []}
            rowKey={(t) => t.id}
            columns={[
              { key: 'name', header: 'Name', cell: (t) => t.name },
              { key: 'words', header: 'Words', cell: (t) => (t.bodyEn ?? t.bodyAr ?? '').slice(0, 80) },
              {
                key: 'actions',
                header: '',
                cell: (t) => (
                  <span className="row">
                    <Button onClick={() => setEditing(t)}>Edit</Button>
                    <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(t.id)}>
                      Delete
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
        title={editing?.id ? 'Edit the template' : 'New template'}
        onSubmit={() => editing?.name && save.mutate()}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!editing?.name}>
              Save
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Name" hint="The compound’s own, once.">
            {(p) => <Input {...p} maxLength={80} value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}
          </Field>
          {kind === 'announcement' ? (
            <Field label="Title (English)">
              {(p) => <Input {...p} maxLength={150} value={editing?.titleEn ?? ''} onChange={(e) => setEditing({ ...editing, titleEn: e.target.value })} />}
            </Field>
          ) : null}
          <Field label="Words (English)">
            {(p) => <Textarea {...p} rows={4} value={editing?.bodyEn ?? ''} onChange={(e) => setEditing({ ...editing, bodyEn: e.target.value })} />}
          </Field>
          {kind === 'reply' ? (
            <Field label="Words (Arabic)">
              {(p) => <Textarea {...p} rows={4} dir="rtl" value={editing?.bodyAr ?? ''} onChange={(e) => setEditing({ ...editing, bodyAr: e.target.value })} />}
            </Field>
          ) : null}
          <ErrorAlert error={save.error ?? remove.error} />
        </div>
      </Dialog>
    </>
  );
}
