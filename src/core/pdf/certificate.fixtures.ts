import type { CertificateContent } from './certificate';

/**
 * A bilingual certificate with Arabic names, numbers and mixed text: the
 * template's pinned output (certificate.spec.ts) and the rasterised sample
 * a person looks at (test/pdf). The instant is fixed, so are the bytes.
 */
export const SAMPLE_CREATED_AT = new Date('2026-10-27T11:05:00Z');

export const SAMPLE: CertificateContent = {
  template: 'certificate.v2',
  compound: 'كمبوند الياسمين — Al Yasmin Compound',
  titleEn: 'Clearance certificate',
  titleAr: 'شهادة إخلاء طرف',
  number: 'CL-000123',
  rows: [
    { labelEn: 'Unit', labelAr: 'الوحدة', value: 'B-12' },
    { labelEn: 'Building', labelAr: 'المبنى', value: '3' },
    // One person, in both scripts: Arabic shaping of a name, and its Latin
    // spelling. (A clearance itself names nobody; these rows test the page.)
    { labelEn: 'Occupant', labelAr: 'الساكن', value: 'أحمد محمد السيد' },
    {
      labelEn: 'Occupant (Latin)',
      labelAr: 'الاسم باللاتينية',
      value: 'Ahmed Mohamed El-Sayed',
    },
    { labelEn: 'Balance', labelAr: 'الرصيد', value: '0.00 EGP' },
    {
      labelEn: 'Paid to date',
      labelAr: 'المدفوع حتى تاريخه',
      value: '1,250.00 EGP',
    },
    { labelEn: 'As of', labelAr: 'حتى', value: '2026-10-27 14:05 (+03:00)' },
    { labelEn: 'Valid until', labelAr: 'صالحة حتى', value: '2026-11-26' },
  ],
  statementEn:
    'The management states that unit B-12 owes nothing to the compound as of the date above.',
  statementAr:
    'تشهد الإدارة بأن الوحدة B-12 ليس عليها أي مستحقات للكمبوند حتى التاريخ المذكور أعلاه، والرصيد 0.00 جنيه.',
  verifyUrl: 'https://app.jiwar.example/c',
  verifyCode: 'K7P2-9QX4',
};
