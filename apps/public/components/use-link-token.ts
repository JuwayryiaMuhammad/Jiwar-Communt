'use client';

import { useEffect, useRef, useState } from 'react';
import { parseFragment, type LinkKind } from '@/lib/fragment';

export type LinkToken = { state: 'reading' } | { state: 'missing' } | { state: 'ready'; token: string };

/**
 * Read the link's secret from the fragment once, then take it out of the
 * address bar and the history entry before anything else happens. From here
 * on it lives in this component's memory only: a reload loses it, and the
 * person opens the link again.
 */
export function useLinkToken(kind: LinkKind): LinkToken {
  const [link, setLink] = useState<LinkToken>({ state: 'reading' });
  // Strict mode runs the effect twice; the second run finds no fragment.
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const hash = window.location.hash;
    if (hash) window.history.replaceState(null, '', window.location.pathname);
    const token = parseFragment(hash, kind);
    setLink(token ? { state: 'ready', token } : { state: 'missing' });
  }, [kind]);

  return link;
}
