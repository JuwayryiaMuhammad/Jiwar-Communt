'use client';

import { ButtonLink } from '@jiwar/ui';
import { ArrowLeft, FileText } from 'lucide-react';
import Link from 'next/link';
import { usePermissions } from '@/lib/permissions';

export function personName(p: { fullName?: string | null; erased?: boolean } | null | undefined): string {
  if (!p) return '—';
  return p.erased ? 'Erased account' : (p.fullName ?? 'Unnamed account');
}

/** A resident by name, linked to their page for a role that may open it. */
export function PersonLink({ person }: { person: { id: string; fullName?: string | null; erased?: boolean } }) {
  const { can } = usePermissions();
  return can('residents.read') && !person.erased ? (
    <Link className="table__link" href={`/residents/${person.id}`}>
      {personName(person)}
    </Link>
  ) : (
    <>{personName(person)}</>
  );
}

export interface EvidenceItem {
  id: string;
  contentType: string;
  /** A presigned GET; null once the file is gone. */
  url: string | null;
}

/**
 * Evidence and photos as they are shown: image thumbnails, a link for a
 * PDF, and a line for a file that is gone. The URLs are presigned, so no
 * referrer is sent with them and they are never handed on.
 */
export function Evidence({ items, alt = 'Attachment' }: { items: readonly EvidenceItem[]; alt?: string }) {
  if (!items.length) return null;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' }}>
      {items.map((a) =>
        a.url === null ? (
          <span key={a.id} className="t-secondary">
            File no longer available
          </span>
        ) : a.contentType.startsWith('image/') ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
            <img src={a.url} alt={alt} loading="lazy" referrerPolicy="no-referrer" style={{ maxHeight: 96, maxWidth: 160, borderRadius: 6, display: 'block' }} />
          </a>
        ) : (
          <a key={a.id} className="row" style={{ gap: 4 }} href={a.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
            <FileText size={16} aria-hidden />
            Document (PDF)
          </a>
        ),
      )}
    </div>
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
