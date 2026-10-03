'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/** The active tab lives in `?tab=` so a tab can be linked and survives reload. */
export function useTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get('tab');
  const tab = tabs.includes(raw as T) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => router.replace(next === fallback ? pathname : `${pathname}?tab=${next}`, { scroll: false }),
    [router, pathname, fallback],
  );
  return [tab, set];
}
