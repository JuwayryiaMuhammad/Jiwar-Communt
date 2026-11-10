/** Residents' use of common areas (ADR 0084): app/(dashboard)/space-uses. */
export default {
  title: 'Common-area uses',
  description: 'Residents ask to use a common area for a time; the staff decide.',
  // The areas open to requests.
  openTitle: 'Areas residents may ask for',
  openPick: 'Common area to open',
  openPlaceholder: 'Open a common area…',
  openEmpty: 'No area is open to requests',
  facilityNote: 'A facility: closed to bookings while in use',
  opened: 'Residents may ask for it now.',
  closedToRequests: 'It takes no new requests; what was asked stands.',
  // The requests.
  empty: 'No request',
  'col.when': 'When',
  'col.area': 'Area',
  'col.purpose': 'Purpose',
  'col.guests': 'Guests',
  refuse: 'Refuse',
  approvedToast: 'Approved; the requester is told.',
  refusedToast: 'Refused; the requester is told.',
  cancelledToast: 'Cancelled; the requester is told.',
  refuseTitle: 'Refuse the request?',
  cancelTitle: 'Cancel the approved use?',
  told: 'The requester is told, with the reason.',
  cancelUse: 'Cancel the use',
} as const;
