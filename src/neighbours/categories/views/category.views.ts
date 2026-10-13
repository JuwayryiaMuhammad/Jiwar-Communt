import { ApiProperty } from '@nestjs/swagger';
import type { NeighbourComplaintCategory } from '@prisma/client';

/** A category as whoever files a complaint sees it: only active ones are offered. */
export class ComplaintCategoryOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;

  static from(c: NeighbourComplaintCategory): ComplaintCategoryOptionView {
    return { id: c.id, key: c.key, nameAr: c.nameAr, nameEn: c.nameEn };
  }
}

/** A category as the manager sees it. */
export class ComplaintCategoryView extends ComplaintCategoryOptionView {
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(c: NeighbourComplaintCategory): ComplaintCategoryView {
    return {
      ...ComplaintCategoryOptionView.from(c),
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
