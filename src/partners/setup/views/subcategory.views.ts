import { ApiProperty } from '@nestjs/swagger';
import type { PartnerSubcategory } from '@prisma/client';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';
import type { CategoryWithSubcategories } from '../subcategories.service';

/** A sub-category as a resident sees it. */
export class PartnerSubcategoryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;

  static from(s: PartnerSubcategory): PartnerSubcategoryView {
    return { id: s.id, key: s.key, nameEn: s.nameEn, nameAr: s.nameAr };
  }
}

/** A sub-category as the staff see it: with its category, state and order. */
export class StaffPartnerSubcategoryView extends PartnerSubcategoryView {
  @ApiProperty({ enum: PARTNER_CATEGORIES, enumName: 'PartnerCategory' })
  category: PartnerCategory;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: Number })
  position: number;

  static from(s: PartnerSubcategory): StaffPartnerSubcategoryView {
    return {
      ...PartnerSubcategoryView.from(s),
      category: s.category as PartnerCategory,
      active: s.active,
      position: s.position,
    };
  }
}

/** One category of the closed list, with the compound's active sub-categories. */
export class PartnerCategoryView {
  @ApiProperty({ enum: PARTNER_CATEGORIES, enumName: 'PartnerCategory' })
  category: PartnerCategory;
  @ApiProperty({
    type: String,
    description:
      'The consent a request in this category needs (ADR 0036, 0060), granted at its current version.',
  })
  consentCode: string;
  @ApiProperty({ type: [PartnerSubcategoryView] })
  subcategories: PartnerSubcategoryView[];

  static from(c: CategoryWithSubcategories): PartnerCategoryView {
    return {
      category: c.category,
      consentCode: `partner_share_${c.category}`,
      subcategories: c.subcategories.map((s) => PartnerSubcategoryView.from(s)),
    };
  }
}
