import type { Row } from '../registry';

export const ADMIN_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/roles',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/roles/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: (w) => ({ id: w.bRoleId }), code: 'ROLE_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/roles/{id}/permissions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRoleId }),
      body: () => ({ permissions: ['units.read'] }),
      code: 'ROLE_NOT_FOUND',
    },
    invalid: {
      body: { permissions: 'units.read' },
      fields: [{ field: 'permissions', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/permissions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { maxHouseholdMembers: 0, familyJoinRequiresApproval: 'no' },
      fields: [
        { field: 'familyJoinRequiresApproval', code: 'INVALID_TYPE' },
        {
          field: 'maxHouseholdMembers',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/audit',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { targetId: 'x', to: 'soon' },
      fields: [
        { field: 'targetId', code: 'INVALID_UUID' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  },
];
