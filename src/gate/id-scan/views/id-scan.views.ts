import { ApiProperty } from '@nestjs/swagger';
import { GuardBlocklistEntryView } from '../../blocklist/views/blocklist.views';
import type { IdScanRead } from '../id-scans.service';

class IdScanNamesView {
  @ApiProperty({ type: String, nullable: true })
  en: string | null;
  @ApiProperty({ type: String, nullable: true })
  ar: string | null;
}

class NationalIdCheckView {
  @ApiProperty({
    type: Boolean,
    description:
      'The number’s own structure holds: a real birth date, a known governorate.',
  })
  valid: boolean;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  birthDate: string | null;
}

/**
 * What a document says, for the guard's device once (ADR 0068): no-store,
 * never kept, never audited beyond its outcome. Fill a gate request with
 * it; the blocklist's live entries for the number come with it.
 */
export class IdScanView {
  @ApiProperty({
    enum: ['national_id', 'passport', 'driving_licence', 'other'],
    enumName: 'IdScanDocumentType',
  })
  documentType: string;
  @ApiProperty({
    type: String,
    description: 'Normalized: what an ID lookup takes.',
  })
  number: string;
  @ApiProperty({ type: IdScanNamesView })
  names: IdScanNamesView;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  birthDate: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresOn: string | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Past its expiry by the compound’s today; null when it shows none.',
  })
  expired: boolean | null;
  @ApiProperty({
    type: NationalIdCheckView,
    nullable: true,
    description: 'A national ID’s own check; null for other documents.',
  })
  nationalId: NationalIdCheckView | null;
  @ApiProperty({ type: [GuardBlocklistEntryView] })
  matches: GuardBlocklistEntryView[];

  static from(r: IdScanRead): IdScanView {
    return {
      documentType: r.documentType,
      number: r.number,
      names: r.names,
      birthDate: r.birthDate,
      expiresOn: r.expiresOn,
      expired: r.expired,
      nationalId: r.nationalId,
      matches: r.matches.map((m) => GuardBlocklistEntryView.from(m)),
    };
  }
}
