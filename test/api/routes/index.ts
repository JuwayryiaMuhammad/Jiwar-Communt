import type { Row } from '../registry';
import { ACCOUNTS_ROUTES } from './accounts';
import { EXISTING_ROUTES } from './existing';
import { ME_ROUTES } from './me';
import { PLATFORM_ROUTES } from './platform';
import { PUBLIC_ROUTES } from './public';
import { REGISTRATION_ROUTES } from './registration';
import { RESIDENTS_ROUTES } from './residents';
import { UNIT_STATES_ROUTES } from './unit-states';
import { UNITS_ROUTES } from './units';

/** Every endpoint of the API, one row each (ADR 0025). */
export const ROUTES: Row[] = [
  ...EXISTING_ROUTES,
  ...UNITS_ROUTES,
  ...UNIT_STATES_ROUTES,
  ...ACCOUNTS_ROUTES,
  ...RESIDENTS_ROUTES,
  ...REGISTRATION_ROUTES,
  ...PLATFORM_ROUTES,
  ...PUBLIC_ROUTES,
  ...ME_ROUTES,
];
