import { ApiProperty } from '@nestjs/swagger';
import type { Place } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';

/** A place as an app offers it (ADR 0047). */
export class PlaceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: [...REASON_CODES.placeKey],
    enumName: 'PlaceKey',
    nullable: true,
    description:
      'One of the defaults every compound starts with, for the app to name in its own words; null for a place the management added.',
  })
  key: string | null;
  @ApiProperty({ type: String, example: 'Phase B' })
  nameEn: string;
  @ApiProperty({ type: String, example: 'المرحلة ب' })
  nameAr: string;

  static from(p: Place): PlaceView {
    return { id: p.id, key: p.key, nameEn: p.nameEn, nameAr: p.nameAr };
  }
}

/** A place as the management keeps it. */
export class ManagedPlaceView extends PlaceView {
  @ApiProperty({ type: Number, description: 'Lower first.' })
  position: number;
  @ApiProperty({
    type: Boolean,
    description: 'Retired places are offered no more; requests keep them.',
  })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(p: Place): ManagedPlaceView {
    return {
      ...PlaceView.from(p),
      position: p.position,
      active: p.active,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}
