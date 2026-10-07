import { ApiProperty } from '@nestjs/swagger';
import type { PreventiveService } from '@prisma/client';

/** A check-up as a resident picks it: only active ones are offered. */
export class PreventiveServiceOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;

  static from(s: PreventiveService): PreventiveServiceOptionView {
    return { id: s.id, key: s.key, nameAr: s.nameAr, nameEn: s.nameEn };
  }
}

/** A check-up as the manager sees it. */
export class PreventiveServiceView extends PreventiveServiceOptionView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The category whose technicians do it.',
  })
  categoryId: string;
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(s: PreventiveService): PreventiveServiceView {
    return {
      ...PreventiveServiceOptionView.from(s),
      categoryId: s.categoryId,
      position: s.position,
      active: s.active,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
