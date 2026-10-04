import { ApiProperty } from '@nestjs/swagger';
import type { Specialty } from '@prisma/client';

/** A specialty as dispatch and the manager see it. */
export class SpecialtyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ type: Boolean })
  active: boolean;

  static from(s: Specialty): SpecialtyView {
    return {
      id: s.id,
      key: s.key,
      nameAr: s.nameAr,
      nameEn: s.nameEn,
      active: s.active,
    };
  }
}

/** A technician's specialty: its id and code. */
export class SpecialtyRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;

  static from(s: { id: string; key: string }): SpecialtyRefView {
    return { id: s.id, key: s.key };
  }
}
