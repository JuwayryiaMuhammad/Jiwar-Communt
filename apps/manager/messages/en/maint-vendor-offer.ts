/** Offering a queued ticket to a vendor (ADR 0088): components/maintenance/ticket-vendor-offer, on the ticket's page. */
export default {
  title: 'Offered to a vendor',
  offer: 'Offer to a vendor',
  withdraw: 'Take the offer back',
  none: 'Not offered to a vendor.',
  aVendor: 'A vendor',
  liveOffer: 'Offered to {vendor} on {when}. The ticket stays in the queue, with its SLA clock running, until a contractor takes it.',
  offeredAt: 'Offered {when}',
  decidedAt: 'answered {when}',
  endedAt: 'ended {when}',
  cannotListVendors: 'Offering needs a permission that reads the vendor register, such as managing vendors or assets.',
  offerTitle: 'Offer {number} to a vendor',
  offerDescription:
    'The vendor’s contractors are told. They see the work, its category, priority and place, and your note — never the unit, a resident or the ticket’s own words. The first to take it becomes the ticket’s technician.',
  vendor: 'Vendor',
  vendorHint: 'An active vendor with a contractor who can take this category.',
  note: 'Note for the vendor',
  noteHint: 'What the vendor needs to know before taking it. Never a person’s name.',
  offered: '{number} is offered to {vendor}.',
  withdrawTitle: 'Take the offer on {number} back?',
  withdrawDescription: 'The vendor’s contractors no longer see it. The ticket stays in the queue.',
  withdrawn: 'The offer on {number} is taken back.',
} as const;
