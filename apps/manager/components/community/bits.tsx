'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { Button, ButtonLink, CardHeader, Checkbox, Field, Input, Select, Textarea } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { fetchers, keys, type CommunityAttachment } from '@/lib/queries';
import { audienceBody, type Occupancy } from './logic';

export const MAX_ATTACHMENTS = 5;

export interface AudienceValue {
  occupancy: Occupancy;
  buildings: string[];
}
export const EVERYONE: AudienceValue = { occupancy: 'everyone', buildings: [] };

/**
 * Who a piece of content is put to: everyone, the owners or the tenants, in
 * the whole compound or in some buildings. The count under it is of now: an
 * audience is read again each time someone opens the content.
 */
export function AudiencePicker({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const buildings = useQuery({ queryKey: keys.communityBuildings, queryFn: fetchers.communityBuildings });
  const size = useQuery({
    queryKey: ['community', 'audience-size', value],
    queryFn: () =>
      unwrap(api.POST('/api/v1/community/audience/preview', { body: { audience: audienceBody(value.occupancy, value.buildings) } })),
  });
  const all = buildings.data?.buildings ?? [];
  const toggle = (building: string, on: boolean) =>
    onChange({ ...value, buildings: on ? [...value.buildings, building].sort() : value.buildings.filter((b) => b !== building) });

  return (
    <div className="stack stack--sm">
      <Field
        label="Who it is for"
        hint={hint ?? 'Owners: every owner of a unit, landlords included, and nobody else. Tenants: tenants and their households.'}
      >
        {(p) => (
          <Select {...p} disabled={disabled} value={value.occupancy} onChange={(e) => onChange({ ...value, occupancy: e.target.value as Occupancy })}>
            <option value="everyone">Everyone</option>
            <option value="owners">Owners only</option>
            <option value="tenants">Tenants only</option>
          </Select>
        )}
      </Field>
      {all.length ? (
        <fieldset className="stack stack--sm" disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="t-secondary">Buildings (none ticked: the whole compound)</legend>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            {all.map((b) => (
              <Checkbox key={b} label={b} checked={value.buildings.includes(b)} onChange={(e) => toggle(b, e.target.checked)} />
            ))}
          </div>
        </fieldset>
      ) : null}
      <span className="t-secondary" aria-live="polite">
        {size.data
          ? `Right now: ${size.data.accounts} ${size.data.accounts === 1 ? 'person' : 'people'} in ${size.data.units} ${size.data.units === 1 ? 'unit' : 'units'}. Whoever moves in later is included; whoever leaves is not.`
          : ' '}
      </span>
    </div>
  );
}

export interface TwoTexts {
  titleEn: string;
  bodyEn: string;
  titleAr: string;
  bodyAr: string;
}
export const NO_TEXT: TwoTexts = { titleEn: '', bodyEn: '', titleAr: '', bodyAr: '' };

/**
 * A title and a text in English, in Arabic, or in both. Nothing is
 * translated: a resident reads the language that was written. The Arabic
 * fields are the only right-to-left inputs.
 */
export function TextFields({
  value,
  onChange,
  error,
  titleLabel = 'Title',
  bodyLabel = 'Text',
  titleKey = 'title',
  bodyKey = 'body',
  titleMax = 150,
  bodyMax = 5000,
}: {
  value: TwoTexts;
  onChange: (next: TwoTexts) => void;
  error: unknown;
  titleLabel?: string;
  bodyLabel?: string;
  /** The API's field names, for its errors: `title`/`body`, `title`/`description`, `title`/`text`. */
  titleKey?: string;
  bodyKey?: string;
  titleMax?: number;
  bodyMax?: number;
}) {
  const set = (patch: Partial<TwoTexts>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label={`${titleLabel} (English)`} error={fieldError(error, `${titleKey}En`)}>
        {(p) => <Input {...p} maxLength={titleMax} value={value.titleEn} onChange={(e) => set({ titleEn: e.target.value })} />}
      </Field>
      <Field label={`${bodyLabel} (English)`} error={fieldError(error, `${bodyKey}En`)}>
        {(p) => <Textarea {...p} rows={4} maxLength={bodyMax} value={value.bodyEn} onChange={(e) => set({ bodyEn: e.target.value })} />}
      </Field>
      <Field label={`${titleLabel} (Arabic)`} error={fieldError(error, `${titleKey}Ar`)}>
        {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={titleMax} value={value.titleAr} onChange={(e) => set({ titleAr: e.target.value })} />}
      </Field>
      <Field
        label={`${bodyLabel} (Arabic)`}
        hint="Write one language or both. A language needs both its fields."
        error={fieldError(error, `${bodyKey}Ar`)}
      >
        {(p) => (
          <Textarea {...p} dir="rtl" lang="ar" rows={4} maxLength={bodyMax} value={value.bodyAr} onChange={(e) => set({ bodyAr: e.target.value })} />
        )}
      </Field>
    </>
  );
}

/** A local date and time. */
export function DateTimeField({
  label,
  hint,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => <Input {...p} type="datetime-local" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

/**
 * The files a piece of content shows: the ones it already has, each of which
 * can be dropped, and new uploads. `kept` and `added` together are what the
 * API takes as `attachmentFileIds`.
 */
export function AttachmentPicker({
  existing,
  kept,
  onKeptChange,
  added,
  onAddedChange,
  label = 'Attach an image or a PDF',
}: {
  existing: readonly CommunityAttachment[];
  kept: string[];
  onKeptChange: (ids: string[]) => void;
  added: string[];
  onAddedChange: (ids: string[]) => void;
  label?: string;
}) {
  const count = kept.length + added.length;
  return (
    <div className="stack stack--sm">
      {existing
        .filter((a) => kept.includes(a.id))
        .map((a) => (
          <span key={a.id} className="row" style={{ gap: 8 }}>
            <AttachmentLink attachment={a} />
            <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => onKeptChange(kept.filter((id) => id !== a.id))}>
              Remove
            </Button>
          </span>
        ))}
      {added.length ? (
        <span className="row" style={{ gap: 8 }}>
          <span className="t-secondary">
            {added.length} new file{added.length === 1 ? '' : 's'} uploaded
          </span>
          <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => onAddedChange([])}>
            Remove the new files
          </Button>
        </span>
      ) : null}
      <FileUpload
        purpose="community_attachment"
        label={count ? `${label} (${count} of ${MAX_ATTACHMENTS})` : label}
        disabled={count >= MAX_ATTACHMENTS}
        onUploaded={(id) => onAddedChange([...added, id])}
      />
    </div>
  );
}

function AttachmentLink({ attachment }: { attachment: CommunityAttachment }) {
  if (!attachment.url) return <span className="t-secondary">File no longer available</span>;
  return (
    <a href={attachment.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
      {attachment.contentType.startsWith('image/') ? (
        <img src={attachment.url} alt="Attachment" referrerPolicy="no-referrer" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 8, display: 'block' }} />
      ) : (
        'Document (PDF)'
      )}
    </a>
  );
}

/** Files as they are shown: images inline, anything else as a link. */
export function Attachments({ items }: { items: readonly CommunityAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
      {items.map((a) => (
        <AttachmentLink key={a.id} attachment={a} />
      ))}
    </div>
  );
}

/** Text in the two languages, each shown only when it was written. */
export function TwoLanguages({
  en,
  ar,
  strong,
}: {
  en: string | null | undefined;
  ar: string | null | undefined;
  strong?: boolean;
}) {
  const cls = strong ? 'table__primary' : undefined;
  return (
    <span className="stack stack--sm">
      {en ? (
        <span className={cls} style={{ whiteSpace: 'pre-wrap' }}>
          {en}
        </span>
      ) : null}
      {ar ? (
        <span className={en ? 't-secondary' : cls} dir="rtl" lang="ar" style={{ whiteSpace: 'pre-wrap' }}>
          {ar}
        </span>
      ) : null}
    </span>
  );
}

/** A card's title with a line under it. */
export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <CardHeader title={title} actions={actions}>
      {description ? <span className="t-secondary">{description}</span> : null}
    </CardHeader>
  );
}

/** The way back from a detail page to its list. */
export function Back({ href, label }: { href: string; label: string }) {
  return (
    <ButtonLink href={href} variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
      {label}
    </ButtonLink>
  );
}
