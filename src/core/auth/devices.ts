import { isUUID } from 'class-validator';

/** The header the apps send with every login: a UUID made at install. */
export const INSTALL_ID_HEADER = 'x-jiwar-install-id';

export type DeviceType =
  'ios' | 'android' | 'desktop_web' | 'mobile_web' | 'unknown';

export interface DeviceIdentity {
  source: 'app' | 'web';
  /** What the keyed hash is taken of: the install id, or browser and OS. */
  material: string;
  /** All a notification says about the device (ADR 0036). */
  deviceType: DeviceType;
}

type Os = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';
type Browser =
  'edge' | 'opera' | 'samsung' | 'firefox' | 'chrome' | 'safari' | 'other';

/** A coarse reading of a user agent: the OS and the browser family. */
export function classifyUserAgent(ua: string | null | undefined): {
  os: Os;
  browser: Browser;
  mobile: boolean;
} {
  const s = ua ?? '';
  const os: Os = /iPhone|iPad|iPod/.test(s)
    ? 'ios'
    : /Android/.test(s)
      ? 'android'
      : /Windows/.test(s)
        ? 'windows'
        : /Macintosh|Mac OS X/.test(s)
          ? 'macos'
          : /Linux|X11|CrOS/.test(s)
            ? 'linux'
            : 'other';
  const browser: Browser = /Edg(e|A|iOS)?\//.test(s)
    ? 'edge'
    : /OPR\/|Opera/.test(s)
      ? 'opera'
      : /SamsungBrowser\//.test(s)
        ? 'samsung'
        : /Firefox\/|FxiOS\//.test(s)
          ? 'firefox'
          : /Chrome\/|CriOS\//.test(s)
            ? 'chrome'
            : /Safari\//.test(s)
              ? 'safari'
              : 'other';
  const mobile = os === 'ios' || os === 'android' || /Mobile/.test(s);
  return { os, browser, mobile };
}

/**
 * Which device a login comes from (ADR 0036). An app sends its install id
 * (`X-Jiwar-Install-Id`); a browser is known by its family and OS. Nothing
 * else (no IP, no place) ever enters it.
 */
export function deviceIdentity(
  userAgent: string | null | undefined,
  installId: string | null | undefined,
): DeviceIdentity {
  const { os, browser, mobile } = classifyUserAgent(userAgent);
  if (installId && isUUID(installId)) {
    return {
      source: 'app',
      material: installId.toLowerCase(),
      deviceType: os === 'ios' || os === 'android' ? os : 'unknown',
    };
  }
  return {
    source: 'web',
    material: `${browser}/${os}`,
    deviceType:
      browser === 'other' && os === 'other'
        ? 'unknown'
        : mobile
          ? 'mobile_web'
          : 'desktop_web',
  };
}
