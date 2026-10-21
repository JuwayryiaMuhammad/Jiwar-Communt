'use client';

import { fieldError, formatDate, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { inEither } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardPublication } from '@/lib/queries';

const KIND_TEXT: Record<string, string> = { decision: 'Decision', minutes: 'Minutes' };

function Publish({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<'decision' | 'minutes'>('decision');
  const [decidedOn, setDecidedOn] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [titleEn, setTitleEn] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [pdf, setPdf] = useState<string | null>(null);
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/governance/publications', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            kind,
            decidedOn,
            titleEn: titleEn.trim(),
            bodyEn: bodyEn.trim(),
            ...(pdf ? { attachmentFileId: pdf } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Published to the owners, in their announcements. Nobody was pushed.');
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(publish.error, f);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Publish for the board"
      description="To the owners, as an announcement of the board, out at once. While a board sits."
      onSubmit={() => publish.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={publish.isPending} disabled={!titleEn.trim() || !bodyEn.trim()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label="What">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'decision' | 'minutes')}>
                <option value="decision">A decision</option>
                <option value="minutes">Minutes of a meeting</option>
              </Select>
            )}
          </Field>
          <Field label="Decided or met on" error={err('decidedOn')}>
            {(p) => <Input {...p} type="date" value={decidedOn} onChange={(e) => setDecidedOn(e.target.value)} />}
          </Field>
        </div>
        <Field label="Title" error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={150} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label="Text" error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={6} maxLength={5000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        {pdf ? <p className="t-secondary">A PDF is attached.</p> : null}
        <FileUpload purpose="community_attachment" label="Attach the PDF" onUploaded={setPdf} disabled={pdf !== null} />
        {err('attachmentFileId') ? <p className="t-error">{err('attachmentFileId')}</p> : null}
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

/** The board's decisions and minutes (ADR 0051). */
export default function BoardDecisionsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const list = useCursorList(keys.boardPublications, (c) => fetchers.boardPublications(c), { enabled: allowed });
  const [publishing, setPublishing] = useState(false);
  const archive = useAction(
    (id: string) => unwrap(api.POST('/api/v1/governance/publications/{id}/archive', { params: { path: { id } } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show('Archived: it is down for good.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Decisions" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Decisions"
        description="The board’s decisions and minutes, as the owners read them in their announcements."
        actions={
          <Button variant="primary" onClick={() => setPublishing(true)}>
            Publish
          </Button>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardPublication>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="Nothing published yet"
            columns={[
              { key: 'k', header: 'What', cell: (p) => KIND_TEXT[p.kind] },
              { key: 't', header: 'Title', cell: (p) => inEither(p.titleEn, p.titleAr) },
              { key: 'd', header: 'Decided', cell: (p) => formatDate(p.decidedOn) },
              { key: 'f', header: 'PDF', cell: (p) => (p.hasAttachment ? 'Yes' : '—') },
              { key: 'p', header: 'Published', cell: (p) => formatDateTime(p.publishedAt) },
              {
                key: 's',
                header: 'Status',
                cell: (p) => <StatusBadge status={p.archivedAt ? 'archived' : 'published'} />,
              },
              {
                key: 'a',
                header: '',
                cell: (p) =>
                  p.archivedAt ? null : (
                    <Button variant="text" onClick={() => archive.mutate(p.id)}>
                      Archive
                    </Button>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
          <ErrorAlert error={archive.error} />
        </QueryState>
      </Card>
      {publishing ? <Publish onClose={() => setPublishing(false)} /> : null}
    </>
  );
}
