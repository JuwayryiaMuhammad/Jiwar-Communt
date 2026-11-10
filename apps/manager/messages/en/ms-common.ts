/** Maintenance setup's shared words (ADR 0064, 0081): components/maintenance-setup/names and format. */
export default {
  'duration.d': '{n} d',
  'duration.h': '{n} h',
  'duration.m': '{n} min',
  nameEn: 'Name (English)',
  nameAr: 'Name (Arabic)',
  code: 'Code',
  codeHint: 'Lowercase letters, digits and underscores, e.g. {example}. It can never be changed later.',
  codeInvalid: 'Start with a letter; 2 to 40 lowercase letters, digits or underscores.',
} as const;
