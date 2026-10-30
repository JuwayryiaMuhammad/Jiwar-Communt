'use client';

import { formatDate, unwrap, type Schema } from '@jiwar/api';
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
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';

type Summary = Schema<'CompoundDocumentSummaryView'>;
type Kind = 'bylaws' | 'occupant_rights' | 'conduct_guide' | 'moving_guide' | 'saving_tips';
const KEY = ['compound-documents'] as const;

const KINDS: { value: Kind; label: string; hint: string }[] = [
  {
    value: 'bylaws',
    label: 'Bylaws',
    hint: 'Adopted by the board: cite its published decision.',
  },
  {
    value: 'occupant_rights',
    label: 'Your rights',
    hint: 'What an occupant may rely on, in plain words.',
  },
  {
    value: 'conduct_guide',
    label: 'Code of conduct',
    hint: 'How neighbours live together.',
  },
  {
    value: 'moving_guide',
    label: 'Moving guide',
    hint: 'Renewing a lease or moving out: what each means, the dates, the fees.',
  },
  {
    value: 'saving_tips',
    label: 'Saving tips',
    hint: 'How a household uses less water, power and gas.',
  },
];

/** A plain-language starting point for the occupants' rights (ADR 0062); the management edits it. */
const RIGHTS_TEMPLATE = `## Your home
- You may live in your unit and use the common areas the compound opens to residents.
- Nobody enters your unit without you, except in an emergency.

## Your requests
- You may ask the management anything, and get an answer within the time it publishes.
- You may appeal a decision about your unit, first to the management, then to the board.

## Your money
- You see every invoice of your unit and every payment, and you may dispute an invoice.
- A deposit the management holds is yours; you may ask for it back when you leave.`;

/**
 * The compound's documents (ADR 0062): the bylaws, the occupants' rights,
 * the code of conduct and the moving guide. Each is a series of versions;
 * an amendment is a new version that says what it changes. Everyone in the
 * compound reads them in the app; a new version of the bylaws or the
 * rights is announced to everyone.
 */
export default function CompoundDocumentsPage() {
  const [publishing, setPublishing] = useState<Kind | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/compound-documents')),
  });
  const latest = (k: Kind) => list.data?.find((d) => d.kind === k);

  return (
    <>
      <PageHeader
        title="Compound documents"
        description="What residents read in the app: the bylaws, their rights, the code of conduct and the moving guide. Each new version keeps the ones before."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<(typeof KINDS)[number]>
            rows={KINDS}
            rowKey={(k) => k.value}
            empty=""
            columns={[
              {
                key: 'kind',
                header: 'Document',
                cell: (k) => <strong>{k.label}</strong>,
              },
              {
                key: 'version',
                header: 'Published',
                cell: (k) => {
                  const d: Summary | undefined = latest(k.value);
                  return d ? (
                    <span>
                      Version {d.versionNo} · in force{' '}
                      {formatDate(d.effectiveOn)}{' '}
                      {d.hasFile ? <Badge tone="beige">PDF</Badge> : null}
                    </span>
                  ) : (
                    <span className="t-secondary">Not published yet</span>
                  );
                },
              },
              {
                key: 'act',
                header: '',
                cell: (k) => (
                  <Button size="sm" onClick={() => setPublishing(k.value)}>
                    {latest(k.value) ? 'Publish an amendment' : 'Publish'}
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
  const toast = useToast();
  const meta = KINDS.find((k) => k.value === kind)!;
  const [v, setV] = useState({
    titleEn: meta.label,
    titleAr: '',
    bodyEn: kind === 'occupant_rights' && first ? RIGHTS_TEMPLATE : '',
    bodyAr: '',
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
        toast.show('Published.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${first ? 'Publish' : 'Amend'}: ${meta.label}`}
      description={meta.hint}
      onSubmit={(e) => {
        e.preventDefault();
        publish.mutate(undefined);
      }}
      footer={
        <Button variant="primary" type="submit" loading={publish.isPending}>
          Publish
        </Button>
      }
    >
      <ErrorAlert error={publish.error} />
      <Field label="Title (English)">
        {(p) => (
          <Input {...p} value={v.titleEn} onChange={set('titleEn')} required />
        )}
      </Field>
      <Field label="Title (Arabic)">
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
      <Field label="Text (English)" hint="Markdown.">
        {(p) => (
          <Textarea
            {...p}
            rows={8}
            value={v.bodyEn}
            onChange={set('bodyEn')}
            required
          />
        )}
      </Field>
      <Field label="Text (Arabic)" hint="Markdown.">
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
          <Field label="What it changes (English)">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={v.changesEn}
                onChange={set('changesEn')}
                required
              />
            )}
          </Field>
          <Field label="What it changes (Arabic)">
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
      <Field label="In force from">
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
          label="The board’s decision"
          hint="The id of the decision the board published (Board → Publications)."
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
            ? 'Signed PDF attached — replace'
            : 'Attach the signed PDF (optional)'
        }
        onUploaded={(fileId) => setV({ ...v, fileId })}
      />
    </Dialog>
  );
}
