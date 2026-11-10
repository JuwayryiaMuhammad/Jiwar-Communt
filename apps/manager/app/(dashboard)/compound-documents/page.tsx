'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import ar from '@/messages/ar/compound-docs';
import en from '@/messages/en/compound-docs';

type Summary = Schema<'CompoundDocumentSummaryView'>;
type Kind =
  | 'bylaws'
  | 'occupant_rights'
  | 'conduct_guide'
  | 'moving_guide'
  | 'saving_tips'
  | 'emergency_medical'
  | 'emergency_fire'
  | 'emergency_security'
  | 'emergency_facilities';
const KEY = ['compound-documents'] as const;

const KINDS: Kind[] = [
  'bylaws',
  'occupant_rights',
  'conduct_guide',
  'moving_guide',
  'saving_tips',
  'emergency_medical',
  'emergency_fire',
  'emergency_security',
  'emergency_facilities',
];

/**
 * The compound's documents (ADR 0062): the bylaws, the occupants' rights,
 * the code of conduct and the moving guide. Each is a series of versions;
 * an amendment is a new version that says what it changes. Everyone in the
 * compound reads them in the app; a new version of the bylaws or the
 * rights is announced to everyone.
 */
export default function CompoundDocumentsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const [publishing, setPublishing] = useState<Kind | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/compound-documents')),
  });
  const latest = (k: Kind) => list.data?.find((d) => d.kind === k);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Kind>
            rows={KINDS}
            rowKey={(k) => k}
            empty=""
            columns={[
              {
                key: 'kind',
                header: t('document'),
                cell: (k) => <strong>{t(`kind.${k}`)}</strong>,
              },
              {
                key: 'version',
                header: t('published'),
                cell: (k) => {
                  const d: Summary | undefined = latest(k);
                  return d ? (
                    <span>
                      {t('versionLine', { no: f.number(d.versionNo), date: f.day(d.effectiveOn) })}{' '}
                      {d.hasFile ? <Badge tone="beige">PDF</Badge> : null}
                    </span>
                  ) : (
                    <span className="t-secondary">{t('notPublished')}</span>
                  );
                },
              },
              {
                key: 'act',
                header: '',
                cell: (k) => (
                  <Button size="sm" onClick={() => setPublishing(k)}>
                    {latest(k) ? t('publishAmendment') : t('publish')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {publishing ? (
        <PublishDialog
          kind={publishing}
          first={!latest(publishing)}
          onClose={() => setPublishing(null)}
        />
      ) : null}
    </>
  );
}

function PublishDialog({
  kind,
  first,
  onClose,
}: {
  kind: Kind;
  first: boolean;
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const toast = useToast();
  const [v, setV] = useState({
    titleEn: en[`kind.${kind}`],
    titleAr: ar[`kind.${kind}`],
    bodyEn: kind === 'occupant_rights' && first ? en.rightsTemplate : '',
    bodyAr: kind === 'occupant_rights' && first ? ar.rightsTemplate : '',
    changesEn: '',
    changesAr: '',
    effectiveOn: new Date().toISOString().slice(0, 10),
    boardPublicationId: '',
    fileId: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/compound-documents/versions', {
          body: {
            kind,
            titleEn: v.titleEn,
            titleAr: v.titleAr,
            bodyEn: v.bodyEn,
            bodyAr: v.bodyAr,
            effectiveOn: v.effectiveOn,
            ...(first
              ? {}
              : { changesEn: v.changesEn, changesAr: v.changesAr }),
            ...(kind === 'bylaws'
              ? { boardPublicationId: v.boardPublicationId }
              : {}),
            ...(v.fileId ? { fileId: v.fileId } : {}),
          },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('publishedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t(first ? 'publishTitle' : 'amendTitle', { kind: t(`kind.${kind}`) })}
      description={t(`hint.${kind}`)}
      onSubmit={(e) => {
        e.preventDefault();
        publish.mutate(undefined);
      }}
      footer={
        <Button variant="primary" type="submit" loading={publish.isPending}>
          {t('publish')}
        </Button>
      }
    >
      <ErrorAlert error={publish.error} />
      <Field label={t('titleEn')}>
        {(p) => (
          <Input {...p} dir="ltr" value={v.titleEn} onChange={set('titleEn')} required />
        )}
      </Field>
      <Field label={t('titleAr')}>
        {(p) => (
          <Input
            {...p}
            dir="rtl"
            value={v.titleAr}
            onChange={set('titleAr')}
            required
          />
        )}
      </Field>
      <Field label={t('textEn')} hint={t('markdown')}>
        {(p) => (
          <Textarea
            {...p}
            dir="ltr"
            rows={8}
            value={v.bodyEn}
            onChange={set('bodyEn')}
            required
          />
        )}
      </Field>
      <Field label={t('textAr')} hint={t('markdown')}>
        {(p) => (
          <Textarea
            {...p}
            dir="rtl"
            rows={8}
            value={v.bodyAr}
            onChange={set('bodyAr')}
            required
          />
        )}
      </Field>
      {first ? null : (
        <>
          <Field label={t('changesEn')}>
            {(p) => (
              <Textarea
                {...p}
                dir="ltr"
                rows={3}
                value={v.changesEn}
                onChange={set('changesEn')}
                required
              />
            )}
          </Field>
          <Field label={t('changesAr')}>
            {(p) => (
              <Textarea
                {...p}
                dir="rtl"
                rows={3}
                value={v.changesAr}
                onChange={set('changesAr')}
                required
              />
            )}
          </Field>
        </>
      )}
      <Field label={t('inForceFrom')}>
        {(p) => (
          <Input
            {...p}
            type="date"
            value={v.effectiveOn}
            onChange={set('effectiveOn')}
            required
          />
        )}
      </Field>
      {kind === 'bylaws' ? (
        <Field
          label={t('boardDecision')}
          hint={t('boardDecisionHint')}
        >
          {(p) => (
            <Input
              {...p}
              value={v.boardPublicationId}
              onChange={set('boardPublicationId')}
              required
            />
          )}
        </Field>
      ) : null}
      <FileUpload
        purpose="compound_document"
        label={
          v.fileId
            ? t('fileAttached')
            : t('attachFile')
        }
        onUploaded={(fileId) => setV({ ...v, fileId })}
      />
    </Dialog>
  );
}
