import type { Row } from '../registry';
import { APPROVALS_ROUTES } from './approvals';
import { ATTENDANCE_ROUTES } from './attendance';
import { ACCOUNTS_ROUTES } from './accounts';
import { ADMIN_ROUTES } from './admin';
import { DELEGATIONS_ROUTES } from './delegations';
import { ENTRIES_ROUTES } from './entries';
import { ENTRY_CREDENTIALS_ROUTES } from './entry-credentials';
import { ERASURE_ROUTES } from './erasure';
import { FILES_ROUTES } from './files';
import { GATE_ROUTES } from './gate';
import { EXISTING_ROUTES } from './existing';
import { HOUSEHOLD_ROUTES } from './household';
import {
  AVAILABILITY_ROUTES,
  CONFIRMATION_ROUTES,
  MAINTENANCE_ROUTES,
  MESSAGE_ROUTES,
  TICKET_ROUTES,
  VISIT_ROUTES,
  WORK_ROUTES,
} from './maintenance';
import { ME_ROUTES } from './me';
import { MEMBER_PERMISSIONS_ROUTES } from './member-permissions';
import { NOTIFICATIONS_ROUTES } from './notifications';
import { GATE_PARCELS_ROUTES } from './parcels';
import { PLATFORM_ROUTES } from './platform';
import { PUBLIC_ROUTES } from './public';
import { REGISTRATION_ROUTES } from './registration';
import { RESIDENTS_ROUTES } from './residents';
import { UNIT_STATES_ROUTES } from './unit-states';
import { UNITS_ROUTES } from './units';
import { VISITORS_ROUTES } from './visitors';
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
  ...GATE_PARCELS_ROUTES,
  ...NOTIFICATIONS_ROUTES,
  ...GATE_ROUTES,
  ...VISITORS_ROUTES,
  ...ENTRIES_ROUTES,
  ...APPROVALS_ROUTES,
  ...ATTENDANCE_ROUTES,
  ...FILES_ROUTES,
  ...ENTRY_CREDENTIALS_ROUTES,
  ...MAINTENANCE_ROUTES,
  ...TICKET_ROUTES,
  ...WORK_ROUTES,
  ...AVAILABILITY_ROUTES,
  ...CONFIRMATION_ROUTES,
  ...MESSAGE_ROUTES,
  ...VISIT_ROUTES,
];
