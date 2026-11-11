'use client';

import { ApiError, useErrorText, unwrap, type Schema } from '@jiwar/api';
import { useT } from '@jiwar/i18n';
import { Alert, Button } from '@jiwar/ui';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

type Purpose = Schema<'FilePurpose'>;
type ContentType = Schema<'NewUploadDto'>['contentType'];
type What = 'image5' | 'image10' | 'imageOrPdf10' | 'photo10' | 'pdf10' | 'jpegPng10' | 'csv1';

/** What each purpose accepts (the backend's files/purposes.ts). */
const RULES: Partial<Record<Purpose, { types: readonly ContentType[]; maxBytes: number; what: What }>> = {
  worker_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'image5' },
  document: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // A unit's papers (ADR 0062): a document in its vault, a contract's scan.
  unit_document: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'imageOrPdf10' },
  contract: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'imageOrPdf10' },
  // A works completion inspection's photo (ADR 0063).
  works_inspection_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'photo10' },
  // An emergency entry's photo, before or after (ADR 0083).
  unit_entry_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'photo10' },
  // A compound document version's signed copy (ADR 0062): a PDF only.
  compound_document: { types: ['application/pdf'], maxBytes: 10 * 1024 * 1024, what: 'pdf10' },
  // A message's attachment on a request to the management (ADR 0039).
  request_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // What the staff attach to an announcement, an event or a "we did" note (ADR 0040).
  community_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // Evidence on a complaint's message, and a photo of a lost or found item (ADR 0042).
  complaint_evidence: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  neighbour_post_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'image5' },
  // A compound album's photo (ADR 0071), the staff's.
  gallery_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'image10' },
  // Fit-out (ADR 0074): the management's photo of a common area before and
  // after works, or of a damage claim's damage.
  fitout_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'image10' },
  // The compound's logo on the board's documents (ADR 0075): what a PDF can draw.
  compound_logo: { types: ['image/jpeg', 'image/png'], maxBytes: 10 * 1024 * 1024, what: 'jpegPng10' },
  // A vehicle fine's photo (ADR 0045).
  vehicle_fine_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'image5' },
  // Security (ADR 0053): a banned person's or plate's photo, a violation's.
  blocklist_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'image5' },
  violation_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, what: 'image5' },
  // Board matters (ADR 0055): a request's attachment, an expense's invoice.
  approval_attachment: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  expense_invoice: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // The asset register (ADR 0064): a plan or a manual, and a sheet to import.
  asset_document: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  data_import: { types: ['text/csv'], maxBytes: 1024 * 1024, what: 'csv1' },
  // A tender's documents (ADR 0088): the scope, drawings, the bill of quantities.
  tender_document: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // A staff member's certificate, its paper (ADR 0090).
  staff_certificate: {
    types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    what: 'imageOrPdf10',
  },
  // A delivery's photo on a goods receipt (ADR 0094).
  goods_receipt_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'photo10' },
  // The site map and a building floor's plan (ADR 0084).
  site_map: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'image10' },
  floor_plan: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * 1024 * 1024, what: 'image10' },
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
  const t = useT(en, ar);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const rules = RULES[purpose];
  const what = rules ? t(`upload.${rules.what}`) : '';

  async function upload(file: File) {
    setError(null);
    if (!rules) return setError(t('uploadNotSetUp'));
    if (!(rules.types as readonly string[]).includes(file.type)) return setError(t('uploadNotAccepted', { what }));
    if (file.size > rules.maxBytes) return setError(t('uploadTooLarge', { what }));
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
        throw new Error(t('uploadUnreachable'));
      }
      if (!put.ok) throw new Error(t('uploadRefused', { status: String(put.status) }));
      await unwrap(api.POST('/api/v1/files/{id}/finalize', { params: { path: { id: declared.id } } }));
      await onUploaded(declared.id);
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e) : e instanceof Error ? e.message : t('uploadFailed'));
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
        {rules ? <span className="t-secondary">{what}</span> : null}
      </span>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
