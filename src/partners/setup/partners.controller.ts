import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
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
  CreatePartnerDto,
  ReplacePartnerHoursDto,
  ReplacePartnerPricesDto,
  ReplacePartnerServicesDto,
  UpdatePartnerDto,
} from './dto/partners.dto';
import { PartnersService } from './partners.service';
import { StaffPartnerView } from './views/partner.views';

/** The compound's partners, for the staff who list them (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partners')
export class StaffPartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List every partner, suspended ones included' })
  @ApiOkResponse({ type: ListOf(StaffPartnerView) })
  async list(): Promise<ListResponse<StaffPartnerView>> {
    return bounded(await this.partners.staffList(), (p) =>
      StaffPartnerView.from(p),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a partner' })
  @ApiOkResponse({ type: StaffPartnerView })
  async get(@Param('id', parseId()) id: string): Promise<StaffPartnerView> {
    return StaffPartnerView.from(await this.partners.staffGet(id));
  }

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({ summary: 'List a partner, with what it does' })
  @ApiCreatedResponse({ type: StaffPartnerView })
  async create(@Body() dto: CreatePartnerDto): Promise<StaffPartnerView> {
    return StaffPartnerView.from(await this.partners.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Update a partner: names, description, phone, email, area',
  })
  @ApiOkResponse({ type: StaffPartnerView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePartnerDto,
  ): Promise<StaffPartnerView> {
    return StaffPartnerView.from(await this.partners.update(id, dto));
  }

  @Put(':id/services')
  @NoStore()
  @ApiOperation({ summary: 'Replace what a partner does' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replaceServices(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerServicesDto,
  ): Promise<StaffPartnerView> {
    return StaffPartnerView.from(
      await this.partners.replaceServices(id, dto.services),
    );
  }

  @Put(':id/hours')
  @NoStore()
  @ApiOperation({ summary: 'Replace a partner’s weekly hours' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replaceHours(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerHoursDto,
  ): Promise<StaffPartnerView> {
    return StaffPartnerView.from(
      await this.partners.replaceHours(id, dto.windows),
    );
  }

  @Put(':id/prices')
  @NoStore()
  @ApiOperation({ summary: 'Replace a partner’s announced price list' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replacePrices(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerPricesDto,
  ): Promise<StaffPartnerView> {
    return StaffPartnerView.from(
      await this.partners.replacePrices(id, dto.items),
    );
  }
}
