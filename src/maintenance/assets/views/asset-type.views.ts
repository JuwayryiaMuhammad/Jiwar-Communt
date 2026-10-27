import { ApiProperty } from '@nestjs/swagger';
import type { AssetType } from '@prisma/client';

/** A kind of asset (ADR 0064). Names are the compound's words. */
export class AssetTypeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Whose technicians work on these assets.',
  })
  categoryId: string;
  @ApiProperty({ type: Number, nullable: true })
  expectedLifeYears: number | null;
  @ApiProperty({ type: Boolean })
  active: boolean;

  static from(t: AssetType): AssetTypeView {
    return {
      id: t.id,
      key: t.key,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      categoryId: t.categoryId,
      expectedLifeYears: t.expectedLifeYears,
      active: t.active,
    };
  }
}
