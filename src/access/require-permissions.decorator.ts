import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';

/** The route needs every listed permission (checked by PermissionsGuard). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
