import { ApiProperty } from '@nestjs/swagger';
import type { CommonArea } from '@prisma/client';
import { COMMON_AREA_KINDS, type CommonAreaKind } from '../area-rules';

/** A common area (ADR 0064). Names are the compound's words. */
export class CommonAreaView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: COMMON_AREA_KINDS })
  kind: CommonAreaKind;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  facilityId: string | null;
  @ApiProperty({ type: Number, nullable: true })
  latitude: number | null;
  @ApiProperty({ type: Number, nullable: true })
  longitude: number | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When its current tag was issued; null: none yet.',
  })
  tagIssuedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(a: CommonArea): CommonAreaView {
    return {
      id: a.id,
      kind: a.kind as CommonAreaKind,
      code: a.code,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      building: a.building,
      facilityId: a.facilityId,
      latitude: a.latitude === null ? null : a.latitude.toNumber(),
      longitude: a.longitude === null ? null : a.longitude.toNumber(),
      active: a.active,
      tagIssuedAt: a.tagIssuedAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}

/** A tag, issued once (ADR 0064): print it; it is never shown again. */
export class IssuedTagView {
  @ApiProperty({
    type: String,
    example: 'JWL1.0190…',
    description: 'What the QR holds. The previous tag stopped working.',
  })
  code: string;
  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: Date;
}
