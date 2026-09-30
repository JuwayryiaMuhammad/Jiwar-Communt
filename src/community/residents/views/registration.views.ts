import { ApiProperty } from '@nestjs/swagger';
import { OccupancyType } from '@prisma/client';
import type {
  CreatedRegistrationLink,
  PendingRegistration,
  RegistrationConflict,
  RegistrationLinkView,
} from '../registration.service';

const CONFLICTS: RegistrationConflict[] = [
  'unit_not_found',
  'unit_has_primary',
  'unit_has_residing_occupants',
  'phone_in_use',
  'email_in_use',
  'same_person_existing_account',
  'duplicate_pending_for_unit',
];

export class RegistrationLinkResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;

  static from(l: RegistrationLinkView): RegistrationLinkResponse {
    return { id: l.id, createdAt: l.createdAt, revokedAt: l.revokedAt };
  }
}

/** The new link's token, shown once (no-store). */
export class CreatedLinkView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'Shown once; only its hash is stored.',
  })
  token: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(l: CreatedRegistrationLink): CreatedLinkView {
    return { id: l.id, token: l.token, createdAt: l.createdAt };
  }
}

/**
 * A request under review: what the registrant typed, and the conflicts as
 * of now. Never a document number or a birth date.
 */
export class PendingRegistrationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  fullName: string;
  @ApiProperty({ type: String })
  phone: string;
  @ApiProperty({ type: String })
  email: string;
  @ApiProperty({ type: String, description: 'As the registrant typed it.' })
  unitCode: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null when no unit has that code.',
  })
  unitId: string | null;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({ type: Boolean })
  resides: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ enum: CONFLICTS, isArray: true })
  conflicts: RegistrationConflict[];

  static from(p: PendingRegistration): PendingRegistrationView {
    return {
      id: p.id,
      fullName: p.fullName,
      phone: p.phone,
      email: p.email,
      unitCode: p.unitCode,
      unitId: p.unitId,
      occupancyType: p.occupancyType,
      resides: p.resides,
      createdAt: p.createdAt,
      conflicts: [...p.conflicts],
    };
  }
}

export class ApprovedRegistrationView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  occupancyId: string;

  static from(a: {
    accountId: string;
    occupancyId: string;
  }): ApprovedRegistrationView {
    return { accountId: a.accountId, occupancyId: a.occupancyId };
  }
}
