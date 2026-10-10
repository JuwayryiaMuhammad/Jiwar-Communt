import 'server-only';
import { callRefresh, type BffProxyConfig, type SessionTokens } from '@jiwar/bff';
import { SESSION_PREFIX } from './session-prefix';

/** A manager-account token set from the tenant auth API, or null. */
export function managerTokens(body: Record<string, unknown> | undefined): SessionTokens | null {
  if (!body || body.accountType !== 'manager') return null;
  const { accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresAt } = body;
  if (
    typeof accessToken !== 'string' ||
    typeof accessTokenExpiresIn !== 'number' ||
    typeof refreshToken !== 'string' ||
    typeof refreshTokenExpiresAt !== 'string'
  ) {
    return null;
  }
  return { accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresAt };
}

/** Never through the generic proxy: the platform API, auth, and public flows. */
const BLOCKED = [
  '/api/v1/platform/',
  '/api/v1/auth/',
  '/api/v1/public/',
  '/api/v1/invites/accept/',
  '/api/v1/registrations/start',
  '/api/v1/registrations/complete',
];

export const managerBff: BffProxyConfig = {
  cookiePrefix: SESSION_PREFIX,
  isAllowed: (path) => path.startsWith('/api/v1/') && !BLOCKED.some((p) => path.startsWith(p)),
  refresh: (refreshToken, userAgent) =>
    callRefresh('/api/v1/auth/refresh', refreshToken, managerTokens, userAgent),
};

/** The single-use login ticket between code verification and account choice. */
export const TICKET_COOKIE = `${SESSION_PREFIX}_lt`;
/** Compound name for the shell (the tenant API's /me has no tenant name). */
export const TENANT_COOKIE = `${SESSION_PREFIX}_tn`;
