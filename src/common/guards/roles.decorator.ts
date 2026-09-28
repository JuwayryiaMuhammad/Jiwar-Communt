import { SetMetadata } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given account types (checked by RolesGuard). */
export const Roles = (...types: AccountType[]) => SetMetadata(ROLES_KEY, types);
