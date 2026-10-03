import 'server-only';
import { callRefresh, type BffProxyConfig, type SessionTokens } from '@jiwar/bff';
import { SESSION_PREFIX } from './session-prefix';

/** A full-scope platform token set, or null (password-change tokens have no refresh). */
export function fullTokens(body: Record<string, unknown> | undefined): SessionTokens | null {
  if (!body || body.scope !== 'full') return null;
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

/**
 * The super admin app reaches the platform API only, never a compound's.
 * Platform auth goes through the dedicated /bff/auth routes.
 */
export const adminBff: BffProxyConfig = {
  cookiePrefix: SESSION_PREFIX,
  isAllowed: (path) =>
    path.startsWith('/api/v1/platform/') && !path.startsWith('/api/v1/platform/auth/'),
  refresh: (refreshToken) => callRefresh('/api/v1/platform/auth/refresh', refreshToken, fullTokens),
};

/** The restricted token of a forced password change, kept for that call only. */
export const PASSWORD_CHANGE_COOKIE = `${SESSION_PREFIX}_pc`;
/** Display email of the signed-in admin (the platform API has no /me). */
export const WHO_COOKIE = `${SESSION_PREFIX}_who`;
