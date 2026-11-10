/** The gate's settings (ADR 0056, 0068): app/(dashboard)/security/gate-settings. */
export default {
  title: 'Gate settings',
  description: 'Field exceptions, visits, patrols, recordings, calls, how busy a gate reads and face checks at the gate.',
  saved: 'Saved. What was asked before keeps its own times.',
  rangeOff: '{min}–{max}; empty: off',
  wholeNumber: 'A whole number from {min} to {max}.',
  faceChecks: 'Face checks',
  on: 'On',
  off: 'Off',
  faceOffDone: 'Face checks are off: the vendor’s templates are being removed.',
  faceOnDone: 'Face checks are on: the blocklist’s faces are being enrolled.',
  faceExplain:
    'A guard’s photo of someone at the gate is searched against the faces of the live blocklist entries. A possible match is the guard’s to judge and the keepers’ to hear of: nobody is refused by a face alone, and the vendor’s score is never shown.',
  noticePosted: 'A visible notice that faces are checked is posted at every gate',
  turnOff: 'Turn face checks off',
  turnOn: 'Turn face checks on',
} as const;
