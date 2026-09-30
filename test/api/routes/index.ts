import type { Row } from '../registry';
import { ACCOUNTS_ROUTES } from './accounts';
import { EXISTING_ROUTES } from './existing';
import { PLATFORM_ROUTES } from './platform';
import { PUBLIC_ROUTES } from './public';
import { UNITS_ROUTES } from './units';

/** Every endpoint of the API, one row each (ADR 0025). */
export const ROUTES: Row[] = [
  ...EXISTING_ROUTES,
  ...UNITS_ROUTES,
  ...ACCOUNTS_ROUTES,
  ...PLATFORM_ROUTES,
  ...PUBLIC_ROUTES,
];
