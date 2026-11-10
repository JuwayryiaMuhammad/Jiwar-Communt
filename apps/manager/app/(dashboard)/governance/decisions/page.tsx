'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { inLocale } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardPublication } from '@/lib/queries';
import ar from '@/messages/ar/gov-decisions';
import en from '@/messages/en/gov-decisions';

function Publish({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('published'));
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
      title={t('publishTitle')}
      description={t('publishDescription')}
      onSubmit={() => publish.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={publish.isPending} disabled={!titleEn.trim() || !bodyEn.trim()}>
            {t('publish')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('what')}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'decision' | 'minutes')}>
                <option value="decision">{t('optionDecision')}</option>
                <option value="minutes">{t('optionMinutes')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('decidedOrMet')} error={err('decidedOn')}>
            {(p) => <Input {...p} type="date" value={decidedOn} onChange={(e) => setDecidedOn(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('titleLabel')} error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={150} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label={t('text')} error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={6} maxLength={5000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        {pdf ? <p className="t-secondary">{t('pdfAttached')}</p> : null}
        <FileUpload purpose="community_attachment" label={t('attachPdf')} onUploaded={setPdf} disabled={pdf !== null} />
        {err('attachmentFileId') ? <p className="t-error">{err('attachmentFileId')}</p> : null}
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

/** The board's decisions and minutes (ADR 0051). */
export default function BoardDecisionsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const list = useCursorList(keys.boardPublications, (cursor) => fetchers.boardPublications(cursor), { enabled: allowed });
  const [publishing, setPublishing] = useState(false);
  const archive = useAction(
    (id: string) => unwrap(api.POST('/api/v1/governance/publications/{id}/archive', { params: { path: { id } } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show(t('archived')) },
  );
  if (ready && !allowed)
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
          <Button variant="primary" onClick={() => setPublishing(true)}>
            {t('publish')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardPublication>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('nothing')}
            columns={[
              { key: 'k', header: t('what'), cell: (p) => (p.kind === 'minutes' ? t('kind.minutes') : t('kind.decision')) },
              { key: 't', header: t('titleLabel'), cell: (p) => inLocale(locale, p.titleEn, p.titleAr) },
              { key: 'd', header: t('col.decided'), cell: (p) => f.day(p.decidedOn) },
              { key: 'f', header: t('col.pdf'), cell: (p) => (p.hasAttachment ? c('yes') : '—') },
              { key: 'p', header: t('col.published'), cell: (p) => f.dateTime(p.publishedAt) },
              {
                key: 's',
                header: c('status'),
                cell: (p) => <StatusBadge status={p.archivedAt ? 'archived' : 'published'} />,
              },
              {
                key: 'a',
                header: '',
                cell: (p) =>
                  p.archivedAt ? null : (
                    <Button variant="text" onClick={() => archive.mutate(p.id)}>
                      {t('archive')}
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
