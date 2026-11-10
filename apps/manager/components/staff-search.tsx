'use client';

import { useT } from '@jiwar/i18n';
import { useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchers, keys, type StaffSearchHit } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

/** Where a hit opens. */
function hrefOf(h: StaffSearchHit): string {
  switch (h.type) {
    case 'unit':
      return `/units/${h.id}`;
    case 'building':
      return '/units?tab=buildings';
    case 'resident':
      return `/residents/${h.id}`;
    case 'staff':
      return '/staff';
    case 'ticket':
      return `/maintenance/${h.id}`;
    case 'asset':
      return `/assets/${h.id}`;
  }
}

/**
 * The top bar's search (ADR 0072): one field, results by kind, each kind
 * only from what the account may read. Waits for two characters and a
 * short pause; `/` focuses it.
 */
export function StaffSearch() {
  const t = useT(en, ar);
  const c = useCommonT();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      e.preventDefault();
      document.getElementById('staff-search')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hits = useQuery({
    queryKey: keys.staffSearch(q),
    queryFn: () => fetchers.staffSearch(q),
    enabled: q.length >= 2,
  });
  const rows = hits.data?.data ?? [];
  const kinds = [...new Set(rows.map((h) => h.type))];
  return (
    <div className="search" style={{ position: 'relative' }}>
      <label className="sr-only" htmlFor="staff-search">
        {c('search')}
      </label>
      <Search aria-hidden size={16} />
      <input
        id="staff-search"
        className="input"
        type="search"
        placeholder={t('searchPlaceholder')}
        value={text}
        maxLength={64}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && q.length >= 2 ? (
        <div className="card" role="listbox" style={{ position: 'absolute', top: '100%', insetInlineEnd: 0, width: 360, zIndex: 20, padding: 8 }}>
          {hits.isPending ? <div className="t-meta">{t('searching')}</div> : null}
          {hits.isSuccess && rows.length === 0 ? <div className="t-meta">{t('nothingFound')}</div> : null}
          {kinds.map((k) => (
            <div key={k} className="stack stack--sm" style={{ marginBottom: 8 }}>
              <div className="t-label">{t(`kind.${k}`)}</div>
              {rows
                .filter((h) => h.type === k)
                .map((h) => (
                  <Link key={`${h.type}:${h.id}`} className="table__link" href={hrefOf(h)} onClick={() => setOpen(false)}>
                    {h.title}
                    {h.subtitle ? <span className="t-meta"> · {h.subtitle}</span> : null}
                  </Link>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
