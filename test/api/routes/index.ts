import type { Row } from '../registry';
import { ACCOUNTS_ROUTES } from './accounts';
import { ADMIN_ROUTES } from './admin';
import { DELEGATIONS_ROUTES } from './delegations';
import { ERASURE_ROUTES } from './erasure';
import { EXISTING_ROUTES } from './existing';
import { HOUSEHOLD_ROUTES } from './household';
import { ME_ROUTES } from './me';
import { MEMBER_PERMISSIONS_ROUTES } from './member-permissions';
import { PLATFORM_ROUTES } from './platform';
import { PUBLIC_ROUTES } from './public';
import { REGISTRATION_ROUTES } from './registration';
import { RESIDENTS_ROUTES } from './residents';
import { UNIT_STATES_ROUTES } from './unit-states';
import { UNITS_ROUTES } from './units';
import { WORKERS_ROUTES } from './workers';

/** Every endpoint of the API, one row each (ADR 0025). */
export const ROUTES: Row[] = [
  ...EXISTING_ROUTES,
  ...UNITS_ROUTES,
  ...UNIT_STATES_ROUTES,
  ...ACCOUNTS_ROUTES,
  ...RESIDENTS_ROUTES,
  ...REGISTRATION_ROUTES,
  ...ERASURE_ROUTES,
  ...ADMIN_ROUTES,
  ...HOUSEHOLD_ROUTES,
  ...MEMBER_PERMISSIONS_ROUTES,
  ...DELEGATIONS_ROUTES,
  ...WORKERS_ROUTES,
  ...PLATFORM_ROUTES,
  ...PUBLIC_ROUTES,
  ...ME_ROUTES,
];
