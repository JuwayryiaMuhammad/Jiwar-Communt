import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/categories.dto';
import { CategoryOptionView, CategoryView } from './views/category.views';

/** The compound's ticket categories, for the manager (ADR 0032). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOkResponse({ type: ListOf(CategoryView) })
  async list(): Promise<ListResponse<CategoryView>> {
    return bounded(await this.categories.list(), (c) => CategoryView.from(c));
  }

  @Post()
  @ApiCreatedResponse({ type: CategoryView })
  async create(@Body() dto: CreateCategoryDto): Promise<CategoryView> {
    return CategoryView.from(await this.categories.create(dto));
  }

  @Patch(':id')
  @ApiOkResponse({ type: CategoryView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return CategoryView.from(await this.categories.update(id, dto));
  }
}

/** What a ticket may be opened under: residents and dispatch. */
@ApiArea('tickets')
@RequireAnyPermission('tickets.create', 'tickets.dispatch')
@Controller('ticket-categories')
export class CategoryOptionsController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOkResponse({ type: ListOf(CategoryOptionView) })
  async list(): Promise<ListResponse<CategoryOptionView>> {
    return bounded(await this.categories.options(), (c) =>
      CategoryOptionView.from(c),
    );
  }
}
