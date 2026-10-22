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
import { DeskLinks } from '../desk/desk-links';
import {
  CreatePartnerDto,
  ReplacePartnerHoursDto,
  ReplacePartnerPricesDto,
  ReplacePartnerServicesDto,
  UpdatePartnerDto,
} from './dto/partners.dto';
import { PartnersService } from './partners.service';
import { StaffPartnerView, type PartnerWithParts } from './views/partner.views';

/** The compound's partners, for the staff who list them (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partners')
export class StaffPartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly deskLinks: DeskLinks,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List every partner, suspended ones included' })
  @ApiOkResponse({ type: ListOf(StaffPartnerView) })
  async list(): Promise<ListResponse<StaffPartnerView>> {
    const partners = await this.partners.staffList();
    const links = await this.deskLinks.liveOf(partners.map((p) => p.id));
    return bounded(partners, (p) =>
      StaffPartnerView.from(p, links.get(p.id) ?? null),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a partner' })
  @ApiOkResponse({ type: StaffPartnerView })
  async get(@Param('id', parseId()) id: string): Promise<StaffPartnerView> {
    const partner = await this.partners.staffGet(id);
    const links = await this.deskLinks.liveOf([id]);
    return StaffPartnerView.from(partner, links.get(id) ?? null);
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
    return this.withLink(await this.partners.update(id, dto));
  }

  @Put(':id/services')
  @NoStore()
  @ApiOperation({ summary: 'Replace what a partner does' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replaceServices(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerServicesDto,
  ): Promise<StaffPartnerView> {
    return this.withLink(await this.partners.replaceServices(id, dto.services));
  }

  @Put(':id/hours')
  @NoStore()
  @ApiOperation({ summary: 'Replace a partner’s weekly hours' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replaceHours(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerHoursDto,
  ): Promise<StaffPartnerView> {
    return this.withLink(await this.partners.replaceHours(id, dto.windows));
  }

  @Put(':id/prices')
  @NoStore()
  @ApiOperation({ summary: 'Replace a partner’s announced price list' })
  @ApiOkResponse({ type: StaffPartnerView })
  async replacePrices(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePartnerPricesDto,
  ): Promise<StaffPartnerView> {
    return this.withLink(await this.partners.replacePrices(id, dto.items));
  }

  /** A partner as changed, with its live desk link. */
  private async withLink(p: PartnerWithParts): Promise<StaffPartnerView> {
    const links = await this.deskLinks.liveOf([p.id]);
    return StaffPartnerView.from(p, links.get(p.id) ?? null);
  }
}
