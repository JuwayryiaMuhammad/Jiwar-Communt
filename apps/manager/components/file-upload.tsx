'use client';

import { ApiError, errorText, unwrap, type Schema } from '@jiwar/api';
import { Alert, Button } from '@jiwar/ui';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';

type Purpose = Schema<'FilePurpose'>;
type ContentType = Schema<'NewUploadDto'>['contentType'];

/** What each purpose accepts (the backend's files/purposes.ts). */
const RULES: Partial<Record<Purpose, { types: readonly ContentType[]; maxBytes: number; what: string }>> = {
  worker_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'A JPEG, PNG or WebP image, up to 5 MB.' },
  document: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
  // A unit's papers (ADR 0062): a document in its vault, a contract's scan.
  unit_document: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'An image or a PDF, up to 10 MB.' },
  contract: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'An image or a PDF, up to 10 MB.' },
  // A compound document version's signed copy (ADR 0062): a PDF only.
  compound_document: { types: ['application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'A PDF, up to 10 MB.' },
  // A message's attachment on a request to the management (ADR 0039).
  request_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
  // What the staff attach to an announcement, an event or a "we did" note (ADR 0040).
  community_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
  // Evidence on a complaint's message, and a photo of a lost or found item (ADR 0042).
  complaint_evidence: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
  neighbour_post_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'A JPEG, PNG or WebP image, up to 5 MB.' },
  // A vehicle fine's photo (ADR 0045).
  vehicle_fine_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'A JPEG, PNG or WebP image, up to 5 MB.' },
  // Security (ADR 0053): a banned person's or plate's photo, a violation's.
  blocklist_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'A JPEG, PNG or WebP image, up to 5 MB.' },
  violation_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'A JPEG, PNG or WebP image, up to 5 MB.' },
  // Board matters (ADR 0055): a request's attachment, an expense's invoice.
  approval_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
  expense_invoice: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'An image or a PDF, up to 10 MB.',
  },
};

/**
 * Uploads one file the way the API wants (ADR 0029): declare it, PUT the
 * bytes straight to storage with the presigned URL, then finalize. The bytes
 * never pass through this app's server. `onUploaded` gets the finalized
 * file's id, for the feature to attach; nothing is kept in the browser.
 */
export function FileUpload({
  purpose,
  label,
  onUploaded,
  disabled,
}: {
  purpose: Purpose;
  label: string;
  onUploaded: (fileId: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = RULES[purpose];

  async function upload(file: File) {
    setError(null);
    if (!rules) return setError('Uploads are not set up for this kind of file.');
    if (!(rules.types as readonly string[]).includes(file.type)) return setError(`Not accepted: ${rules.what}`);
    if (file.size > rules.maxBytes) return setError(`Too large: ${rules.what}`);
    setBusy(true);
    try {
      const declared = await unwrap(
        api.POST('/api/v1/files/uploads', { body: { purpose, contentType: file.type as ContentType, size: file.size } }),
      );
      let put: Response;
      try {
        put = await fetch(declared.upload.url, { method: declared.upload.method, headers: declared.upload.headers, body: file });
      } catch {
        // The storage host refused the browser (CORS) or cannot be reached from here.
        throw new Error('The file storage could not be reached from this browser.');
      }
      if (!put.ok) throw new Error(`The file storage refused the upload (${put.status}).`);
      await unwrap(api.POST('/api/v1/files/{id}/finalize', { params: { path: { id: declared.id } } }));
      await onUploaded(declared.id);
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e) : e instanceof Error ? e.message : 'The upload failed.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="stack stack--sm">
      <input
        ref={input}
        type="file"
        hidden
        accept={rules?.types.join(',')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" icon={<Upload aria-hidden />} loading={busy} disabled={disabled} onClick={() => input.current?.click()}>
          {label}
        </Button>
        {rules ? <span className="t-secondary">{rules.what}</span> : null}
      </span>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
