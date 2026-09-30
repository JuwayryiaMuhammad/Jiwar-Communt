import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ContactDto } from '../../core/accounts/dto/contact.dto';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import type { ErasedAccount } from '../../core/common/http/personal';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CreateResidentDto, OccupancyInputDto } from './dto/residents.dto';
import { ResidentsService } from './residents.service';
import { OccupancyResponse } from './views/occupancy.views';
import {
  ResidentDetailView,
  ResidentListItemView,
} from './views/resident.views';

type Detail = ResidentDetailView | ErasedAccount;

/** Resident accounts and their occupancies (ADR 0012), for managers. */
@ApiArea('residents')
@Controller('residents')
export class ResidentsController {
  constructor(private readonly residents: ResidentsService) {}

  @RequirePermissions('residents.read')
  @Get()
  @ApiOkResponse({ type: ListOf(ResidentListItemView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ResidentListItemView | ErasedAccount>> {
    return toList(await this.residents.list(q), (r) =>
      ResidentListItemView.from(r),
    );
  }

  /** The account, its login identifiers and its occupancies, atomically. */
  @RequirePermissions('residents.manage')
  @Post()
  @ApiCreatedResponse({ type: ResidentDetailView })
  async create(@Body() dto: CreateResidentDto): Promise<Detail> {
    return ResidentDetailView.from(await this.residents.createResident(dto));
  }

  @RequirePermissions('residents.read')
  @Get(':id')
  @ApiOkResponse({ type: ResidentDetailView })
  async get(@Param('id', parseId()) id: string): Promise<Detail> {
    return ResidentDetailView.from(await this.residents.get(id));
  }

  @RequirePermissions('residents.manage')
  @Patch(':id/contact')
  @ApiOkResponse({ type: ResidentDetailView })
  async updateContact(
    @Param('id', parseId()) id: string,
    @Body() dto: ContactDto,
  ): Promise<Detail> {
    return ResidentDetailView.from(await this.residents.updateContact(id, dto));
  }

  @RequirePermissions('residents.manage')
  @Post(':id/occupancies')
  @ApiCreatedResponse({ type: OccupancyResponse })
  async addOccupancy(
    @Param('id', parseId()) id: string,
    @Body() dto: OccupancyInputDto,
  ): Promise<OccupancyResponse> {
    return OccupancyResponse.from(await this.residents.addOccupancy(id, dto));
  }
}
