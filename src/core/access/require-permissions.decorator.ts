import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'anyPermissions';

/** The route needs every listed permission (checked by PermissionsGuard). */
export const RequirePermissions = (...permissions: Permission[]) =>
  exclusive(REQUIRED_PERMISSIONS_KEY, ANY_PERMISSIONS_KEY, permissions);

/**
 * The route needs at least one of the listed permissions: an action open to
 * two roles (a resident's `workers.manage`, a manager's `workers.review`),
 * where the service's resource check decides the rest.
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  exclusive(ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * One rule per route: declaring both is ambiguous (all or any?), so it
 * fails when the class is loaded, at boot, not on a request.
 */
function exclusive(
  key: string,
  other: string,
  permissions: Permission[],
): MethodDecorator & ClassDecorator {
  return (
    target: object,
    property?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const holder = (descriptor?.value as object | undefined) ?? target;
    if (Reflect.getMetadata(other, holder) !== undefined) {
      throw new Error(
        `${String(property ?? (target as { name?: string }).name)}: use either @RequirePermissions or @RequireAnyPermission, not both`,
      );
    }
    if (descriptor) {
      SetMetadata(key, permissions)(target, property!, descriptor);
    } else {
      SetMetadata(key, permissions)(target as () => void);
    }
  };
}
