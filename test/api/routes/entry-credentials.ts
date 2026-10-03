import type { Row } from '../registry';

/** The resident's phones for the entry QR (ADR 0031). */
export const ENTRY_CREDENTIALS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/me/entry-credentials',
    auth: 'tenant',
    as: 'owner',
    // No permission: the capability decides (NOT_A_RESIDENT, tested apart).
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { deviceName: '' },
      fields: [
        {
          field: 'deviceName',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
      ],
    },
    // The secret, once.
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/entry-credentials',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/entry-credentials/{id}/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    // Another compound's credential is just not found.
    foreign: {
      params: (w) => ({ id: w.bEntryCredentialId }),
      code: 'ENTRY_CREDENTIAL_NOT_FOUND',
    },
    invalid: 'none',
  },
];
