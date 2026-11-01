import { ApiProperty } from '@nestjs/swagger';
import type { BuildingRead } from '../buildings.service';

/** A building of the compound (ADR 0072). */
export class BuildingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: Number, description: 'Units that name it now.' })
  units: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(b: BuildingRead): BuildingView {
    return {
      id: b.id,
      name: b.name,
      units: b.units,
      createdAt: b.createdAt,
    };
  }
}
