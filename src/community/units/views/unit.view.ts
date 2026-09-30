import { ApiProperty } from '@nestjs/swagger';
import type { Unit } from '@prisma/client';

/** A unit in a list, or as created. */
export class UnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(unit: Unit): UnitView {
    return {
      id: unit.id,
      code: unit.code,
      building: unit.building,
      floor: unit.floor,
      createdAt: unit.createdAt,
    };
  }
}
