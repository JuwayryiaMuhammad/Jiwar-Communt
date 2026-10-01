import type { Row } from '../registry';

/** A worker's days at the compound, from the gate log (ADR 0028). */
export const ATTENDANCE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/worker-engagements/{id}/attendance',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEngagementId }),
      code: 'ENGAGEMENT_NOT_FOUND',
    },
    invalid: {
      query: { from: 'yesterday' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
];
