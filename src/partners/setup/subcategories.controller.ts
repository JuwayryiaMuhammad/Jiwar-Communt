import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreatePartnerSubcategoryDto,
  UpdatePartnerSubcategoryDto,
} from './dto/subcategories.dto';
import { SubcategoriesService } from './subcategories.service';
import {
  PartnerCategoryView,
  StaffPartnerSubcategoryView,
} from './views/subcategory.views';

/** The categories of the closed list and their sub-categories, for residents (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.request')
@Controller('partner-categories')
export class PartnerCategoriesController {
  constructor(private readonly subcategories: SubcategoriesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the partner categories with their sub-categories',
  })
  @ApiOkResponse({ type: ListOf(PartnerCategoryView) })
  async list(): Promise<ListResponse<PartnerCategoryView>> {
    return bounded(await this.subcategories.categories(), (c) =>
      PartnerCategoryView.from(c),
    );
  }
}

/** The compound's sub-categories, for the staff who keep them (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partner-subcategories')
export class StaffPartnerSubcategoriesController {
  constructor(private readonly subcategories: SubcategoriesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the sub-categories, retired ones included' })
  @ApiOkResponse({ type: ListOf(StaffPartnerSubcategoryView) })
  async list(): Promise<ListResponse<StaffPartnerSubcategoryView>> {
    return bounded(await this.subcategories.staffList(), (s) =>
      StaffPartnerSubcategoryView.from(s),
    );
  }

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({ summary: 'Name a sub-category under a category' })
  @ApiCreatedResponse({ type: StaffPartnerSubcategoryView })
  async create(
    @Body() dto: CreatePartnerSubcategoryDto,
  ): Promise<StaffPartnerSubcategoryView> {
    return StaffPartnerSubcategoryView.from(
      await this.subcategories.create(dto),
    );
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Rename, reorder, retire or restore a sub-category',
  })
  @ApiOkResponse({ type: StaffPartnerSubcategoryView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePartnerSubcategoryDto,
  ): Promise<StaffPartnerSubcategoryView> {
    return StaffPartnerSubcategoryView.from(
      await this.subcategories.update(id, dto),
    );
  }
}
