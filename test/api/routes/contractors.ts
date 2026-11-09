import { TENDER_STATUSES } from '../../../src/maintenance/tenders/tender-rules';
import type { Row } from '../registry';

const UNKNOWN = '00000000-0000-4000-8000-000000000088';

/** The management's routes (ADR 0088): a technician is denied. */
const manager = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});
/** A vendor's contractor's routes (ADR 0088): a staff technician is denied. */
const contractor = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'contractor',
  denied: 'technician',
  ...row,
});
const tenderOf = (w: { bTenderId: string }) => ({ id: w.bTenderId });
const notFound = 'TENDER_NOT_FOUND';
const badReason = {
  body: { reasonCode: ['x'] },
  fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
};

/** The contractor portal and tenders (ADR 0088). */
export const CONTRACTOR_ROUTES: Row[] = [
  // A vendor's contractor accounts: vendors.manage.
  manager({
    method: 'GET',
    path: '/staff/vendors/{id}/contractors',
    foreign: {
      params: (w) => ({ id: w.bVendorId }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors/{id}/contractors',
    foreign: {
      params: (w) => ({ id: w.bVendorId }),
      body: () => ({
        fullName: 'Foreign Contractor',
        idDocumentType: 'national_id',
        idDocumentNumber: '29001010100015',
        phone: '+201001234567',
        email: 'foreign.contractor@example.com',
      }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: {
        fullName: '',
        idDocumentType: 'national_id',
        idDocumentNumber: '29001010100015',
        phone: '+201001234567',
        email: 'foreign.contractor@example.com',
      },
      fields: [
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 200 },
        },
      ],
    },
  }),
  // Dispatch to a vendor: tickets.dispatch.
  manager({
    method: 'POST',
    path: '/maintenance/tickets/{id}/vendor-dispatch',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ vendorId: w.a.contractorVendorId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { vendorId: 'x' },
      fields: [{ field: 'vendorId', code: 'INVALID_UUID' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/maintenance/tickets/{id}/vendor-dispatch/withdraw',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: badReason,
  }),
  manager({
    method: 'GET',
    path: '/maintenance/tickets/{id}/vendor-dispatches',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  }),
  // The contractor's app.
  contractor({
    method: 'GET',
    path: '/contractor/vendor',
    foreign: 'none',
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/contracts',
    foreign: 'none',
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/dispatches',
    foreign: 'none',
    invalid: {
      query: { open: 'maybe' },
      fields: [
        {
          field: 'open',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  }),
  contractor({
    method: 'POST',
    path: '/contractor/dispatches/{id}/accept',
    foreign: {
      params: (w) => ({ id: w.bVendorDispatchId }),
      code: 'VENDOR_DISPATCH_NOT_FOUND',
    },
    invalid: 'none',
  }),
  contractor({
    method: 'POST',
    path: '/contractor/dispatches/{id}/decline',
    foreign: {
      params: (w) => ({ id: w.bVendorDispatchId }),
      body: () => ({ reasonCode: 'no_capacity' }),
      code: 'VENDOR_DISPATCH_NOT_FOUND',
    },
    invalid: badReason,
  }),
  contractor({
    method: 'GET',
    path: '/contractor/tenders',
    foreign: 'none',
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/tenders/{id}',
    foreign: { params: tenderOf, code: notFound },
    invalid: 'none',
    noStore: true,
  }),
  contractor({
    method: 'POST',
    path: '/contractor/tenders/{id}/bid',
    foreign: {
      params: tenderOf,
      body: () => ({ amount: '1000.00' }),
      code: notFound,
    },
    invalid: {
      body: { amount: 'lots' },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  }),
  contractor({
    method: 'POST',
    path: '/contractor/tenders/{id}/bid/withdraw',
    foreign: { params: tenderOf, code: notFound },
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/invoices',
    foreign: 'none',
    invalid: 'none',
  }),
  contractor({
    method: 'POST',
    path: '/contractor/invoices',
    noStore: true,
    foreign: {
      params: () => ({}),
      body: (w) => ({
        vendorNumber: 'C-1',
        issuedOn: '2026-06-01',
        dueOn: '2026-06-30',
        contractId: w.bContractId,
        invoiceFileId: UNKNOWN,
        lines: [{ description: 'Work', amount: '100.00' }],
      }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: {
        vendorNumber: '',
        issuedOn: '2026-06-01',
        dueOn: '2026-06-30',
        contractId: UNKNOWN,
        invoiceFileId: UNKNOWN,
        lines: [{ description: 'Work', amount: '100.00' }],
      },
      fields: [
        {
          field: 'vendorNumber',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
      ],
    },
  }),
  // Tenders: tenders.manage, and tenders.open for the opening.
  manager({
    method: 'GET',
    path: '/staff/tenders',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: TENDER_STATUSES },
        },
      ],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders',
    noStore: true,
    foreign: 'none',
    invalid: {
      body: {
        title: 'x',
        category: 'maintenance',
        contractKind: 'service',
        bidsDueAt: '2099-02-30T08:00:00Z',
      },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 200 },
        },
        { field: 'bidsDueAt', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/tenders/{id}',
    foreign: { params: tenderOf, code: notFound },
    invalid: 'none',
    noStore: true,
  }),
  manager({
    method: 'PATCH',
    path: '/staff/tenders/{id}',
    noStore: true,
    foreign: {
      params: tenderOf,
      body: () => ({ title: 'Foreign tender' }),
      code: notFound,
    },
    invalid: {
      body: { title: 'x' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 200 },
        },
      ],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/publish',
    noStore: true,
    foreign: { params: tenderOf, code: notFound },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/deadline',
    noStore: true,
    foreign: {
      params: tenderOf,
      body: () => ({ bidsDueAt: '2099-01-01T08:00:00Z' }),
      code: notFound,
    },
    invalid: {
      body: { bidsDueAt: '2027-02-29T09:00:00Z' },
      fields: [{ field: 'bidsDueAt', code: 'INVALID_FORMAT' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/cancel',
    noStore: true,
    foreign: {
      params: tenderOf,
      body: () => ({ reasonCode: 'not_needed' }),
      code: notFound,
    },
    invalid: badReason,
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/documents',
    noStore: true,
    foreign: {
      params: tenderOf,
      body: () => ({ fileId: UNKNOWN, title: 'Scope' }),
      code: notFound,
    },
    invalid: {
      body: { fileId: 'x', title: '' },
      fields: [
        { field: 'fileId', code: 'INVALID_UUID' },
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
      ],
    },
  }),
  manager({
    method: 'DELETE',
    path: '/staff/tenders/{id}/documents/{documentId}',
    noStore: true,
    foreign: {
      params: (w) => ({ id: w.bTenderId, documentId: w.bTenderId }),
      code: notFound,
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/invitations',
    foreign: {
      params: tenderOf,
      body: (w) => ({ vendorId: w.a.contractorVendorId }),
      code: notFound,
    },
    invalid: {
      body: { vendorId: 'x' },
      fields: [{ field: 'vendorId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/invitations/{invitationId}/link',
    foreign: {
      params: (w) => ({
        id: w.bTenderId,
        invitationId: w.bTenderInvitationId,
      }),
      code: notFound,
    },
    invalid: 'none',
    noStore: true,
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/invitations/{invitationId}/revoke',
    noStore: true,
    foreign: {
      params: (w) => ({
        id: w.bTenderId,
        invitationId: w.bTenderInvitationId,
      }),
      code: notFound,
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/opening',
    noStore: true,
    foreign: { params: tenderOf, code: notFound },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/tenders/{id}/award',
    noStore: true,
    foreign: {
      params: tenderOf,
      body: () => ({
        bidId: UNKNOWN,
        code: 'AWARD-1',
        startsOn: '2026-06-01',
        endsOn: '2026-12-31',
      }),
      code: notFound,
    },
    invalid: {
      body: {
        bidId: 'x',
        code: 'AWARD-1',
        startsOn: '2026-02-30',
        endsOn: '2026-12-31',
      },
      fields: [
        { field: 'bidId', code: 'INVALID_UUID' },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  // The bid link's page: the token in the body (ADR 0088).
  {
    method: 'POST',
    path: '/public/tender-bids/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, tenderId: 'x' },
      fields: [
        { field: 'tenderId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/public/tender-bids/bid',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, amount: '100.00' },
      fields: [{ field: 'token', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/public/tender-bids/withdraw',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5 },
      fields: [{ field: 'token', code: 'INVALID_TYPE' }],
    },
  },
  // A bid's documents through its link (ADR 0088): a record upload, then
  // finalized or removed by the file's id, the token in the body.
  {
    method: 'POST',
    path: '/public/tender-bids/uploads',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 'x', title: '', contentType: 'application/pdf', size: 0 },
      // In the DTO's order: the title, then the size.
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'size', code: 'INVALID_NUMBER', params: { min: 1 } },
      ],
    },
  },
  ...(['finalize', 'remove'] as const).map((verb): Row => ({
    method: 'POST',
    path: `/public/tender-bids/documents/{fileId}/${verb}`,
    auth: 'public',
    denied: 'none',
    // A's link, B's id: not one of the link's documents.
    foreign: {
      params: (w) => ({ fileId: w.bTenderId }),
      body: (w) => ({ token: w.aBidToken }),
      code: 'TENDER_BID_DOCUMENT_NOT_FOUND',
    },
    noStore: true,
    invalid: {
      body: { token: 5 },
      fields: [{ field: 'token', code: 'INVALID_TYPE' }],
    },
  })),
];
