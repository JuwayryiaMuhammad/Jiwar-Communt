'use client';

import { useEffect, useState } from 'react';

/**
 * The time now, ticking every `ms` while the component is mounted: for a
 * countdown on screen. The server decides by its own clock; this only
 * shows how long is left.
 */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
