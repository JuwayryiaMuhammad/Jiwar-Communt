/**
 * Metadata marking a platform (super admin) route. The tenant guards skip
 * such routes; PlatformAuthGuard (src/platform/) authenticates them. Kept in
 * common/ so the tenant guards need not import the platform module.
 */
export const PLATFORM_ROUTE_KEY = 'platformRoute';

export interface PlatformRouteOptions {
  /** Accept the restricted token issued while a password change is pending. */
  allowPasswordChange?: boolean;
}
