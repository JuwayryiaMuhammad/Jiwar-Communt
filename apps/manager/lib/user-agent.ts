/**
 * A session's user agent in a few words ("Chrome on Windows"), for the
 * account's own list of sessions. A guess from the string, good enough to
 * tell one's devices apart; an unknown one reads as "Unknown device". The
 * browser and system are names; the words around them come from `t`.
 */
import type { Translate } from '@jiwar/i18n/core';
import type en from '../messages/en/accounts-me.ts';

export function describeUserAgent(t: Translate<typeof en>, userAgent: string | null | undefined): string {
  if (!userAgent) return t('device.unknown');
  const ua = userAgent;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux|X11/.test(ua)
            ? 'Linux'
            : null;
  // Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /okhttp|Dart|CFNetwork/i.test(ua)
              ? t('device.app')
              : null;
  if (browser && os) return t('device.on', { browser, system: os });
  return browser ?? os ?? t('device.unknown');
}
