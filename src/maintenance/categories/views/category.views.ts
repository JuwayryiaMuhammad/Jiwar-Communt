import { ApiProperty } from '@nestjs/swagger';
import { TicketPriority, type TicketCategory } from '@prisma/client';

/** A category as a ticket opener sees it: only active ones are offered. */
export class CategoryOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  defaultPriority: TicketPriority;
  @ApiProperty({ type: Boolean })
  commonAreaAllowed: boolean;

  static from(c: TicketCategory): CategoryOptionView {
    return {
      id: c.id,
      key: c.key,
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      defaultPriority: c.defaultPriority,
      commonAreaAllowed: c.commonAreaAllowed,
    };
  }
}

/** A category as the manager sees it. */
export class CategoryView extends CategoryOptionView {
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(c: TicketCategory): CategoryView {
    return {
      ...CategoryOptionView.from(c),
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}

/** The category on a ticket. */
export class TicketCategoryRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;

  static from(c: {
    id: string;
    key: string;
    nameAr: string;
    nameEn: string;
  }): TicketCategoryRefView {
    return { id: c.id, key: c.key, nameAr: c.nameAr, nameEn: c.nameEn };
  }
}
