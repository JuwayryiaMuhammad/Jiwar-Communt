import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ComplaintCategoriesService } from './categories.service';
import {
  CreateComplaintCategoryDto,
  UpdateComplaintCategoryDto,
} from './dto/categories.dto';
import {
  ComplaintCategoryOptionView,
  ComplaintCategoryView,
} from './views/category.views';

/** The compound's complaint categories, for the manager (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.manage')
@Controller('neighbours/complaint-categories')
export class ComplaintCategoriesController {
  constructor(private readonly categories: ComplaintCategoriesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List complaint categories' })
  @ApiOkResponse({ type: ListOf(ComplaintCategoryView) })
  async list(): Promise<ListResponse<ComplaintCategoryView>> {
    return bounded(await this.categories.list(), (c) =>
      ComplaintCategoryView.from(c),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Create a complaint category' })
  @ApiCreatedResponse({ type: ComplaintCategoryView })
  async create(
    @Body() dto: CreateComplaintCategoryDto,
  ): Promise<ComplaintCategoryView> {
    return ComplaintCategoryView.from(await this.categories.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Update a complaint category' })
  @ApiOkResponse({ type: ComplaintCategoryView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateComplaintCategoryDto,
  ): Promise<ComplaintCategoryView> {
    return ComplaintCategoryView.from(await this.categories.update(id, dto));
  }
}

/** What a complaint may be filed under: residents, and the staff's filter. */
@ApiArea('neighbours')
@RequireAnyPermission('neighbours.complain', 'neighbours.handle')
@Controller('neighbour-complaint-categories')
export class ComplaintCategoryOptionsController {
  constructor(private readonly categories: ComplaintCategoriesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the categories a complaint may be filed under',
  })
  @ApiOkResponse({ type: ListOf(ComplaintCategoryOptionView) })
  async list(): Promise<ListResponse<ComplaintCategoryOptionView>> {
    return bounded(await this.categories.options(), (c) =>
      ComplaintCategoryOptionView.from(c),
    );
  }
}
