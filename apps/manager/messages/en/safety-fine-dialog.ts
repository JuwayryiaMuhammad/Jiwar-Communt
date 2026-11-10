/** A fine's form (ADR 0045): components/vehicles/fine-dialog, used by the fines and parking-reports pages. */
export default {
  unitCode: 'Unit code',
  vehicle: 'Vehicle',
  vehicleHint: 'One of the unit’s registered vehicles, or type the plate below.',
  notRegistered: 'Not registered: type the plate',
  plate: 'Plate',
  reason: 'Reason',
  amount: 'Amount, EGP',
  amountInvalid: 'More than zero, at most 100,000, two decimals.',
  occurredOn: 'Day it happened',
  occurredOnHint: 'Within the last 90 days.',
  note: 'Note for the unit',
  noteHint: 'Optional. The unit’s people read it.',
  photo: 'Photo',
  photoAttached: 'Photo attached.',
  addPhoto: 'Add a photo',
} as const;
