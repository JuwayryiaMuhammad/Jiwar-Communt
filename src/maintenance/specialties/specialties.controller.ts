import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CreateSpecialtyDto,
  SpecialtyIdsDto,
  UpdateSpecialtyDto,
} from './dto/specialties.dto';
import { SpecialtiesService } from './specialties.service';
import { SpecialtyView } from './views/specialty.views';

/**
 * The compound's specialties (ADR 0033). Dispatch reads them, to give
 * technicians theirs; the manager writes them.
 */
@ApiArea('maintenance')
@Controller('maintenance/specialties')
export class SpecialtiesController {
  constructor(private readonly specialties: SpecialtiesService) {}

  @Get()
  @RequirePermissions('tickets.dispatch')
  @ApiOkResponse({ type: ListOf(SpecialtyView) })
  async list(): Promise<ListResponse<SpecialtyView>> {
    return bounded(await this.specialties.list(), (s) => SpecialtyView.from(s));
  }

  @Post()
  @RequirePermissions('maintenance.manage')
  @ApiCreatedResponse({ type: SpecialtyView })
  async create(@Body() dto: CreateSpecialtyDto): Promise<SpecialtyView> {
    return SpecialtyView.from(await this.specialties.create(dto));
  }

  @Patch(':id')
  @RequirePermissions('maintenance.manage')
  @ApiOkResponse({ type: SpecialtyView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateSpecialtyDto,
  ): Promise<SpecialtyView> {
    return SpecialtyView.from(await this.specialties.update(id, dto));
  }
}

/** Which specialties can handle a category: the manager's (ADR 0033). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/categories')
export class CategorySpecialtiesController {
  constructor(private readonly specialties: SpecialtiesService) {}

  /** The whole set; empty means any technician can take the category. */
  @Put(':id/specialties')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  setForCategory(
    @Param('id', parseId()) id: string,
    @Body() dto: SpecialtyIdsDto,
  ): Promise<void> {
    return this.specialties.setForCategory(id, dto.specialtyIds);
  }
}
