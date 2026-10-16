import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  ClaimFoundItemDto,
  FoundItemsQueryDto,
  RegisterFoundItemDto,
} from './dto/found-items.dto';
import { FoundItemsService } from './found-items.service';
import { FoundItemView, StaffFoundItemView } from './views/found-item.views';

/** The gate's lost-and-found register, the guards' side (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate/found-items')
export class GuardFoundItemsController {
  constructor(private readonly items: FoundItemsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Register a found item',
    description:
      'On shift (403 NO_OPEN_SHIFT): what, where, when, photos. The shift and its post are recorded.',
  })
  @ApiCreatedResponse({ type: FoundItemView })
  async register(@Body() dto: RegisterFoundItemDto): Promise<FoundItemView> {
    return await this.items.register(dto, 'gate');
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the register', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(FoundItemView) })
  async list(
    @Query() q: FoundItemsQueryDto,
  ): Promise<ListResponse<FoundItemView>> {
    return toList(await this.items.guardList(q), (i) => i);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a found item' })
  @ApiOkResponse({ type: FoundItemView })
  get(@Param('id', parseId()) id: string): Promise<FoundItemView> {
    return this.items.getForGuard(id);
  }

  @Post(':id/claim')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record its owner’s claim at the gate',
    description:
      'While it is held at the gate (409 FOUND_ITEM_CLOSED once the management has it): a unit’s code and/or a name as told, once.',
  })
  @ApiOkResponse({ type: FoundItemView })
  async claim(
    @Param('id', parseId()) id: string,
    @Body() dto: ClaimFoundItemDto,
  ): Promise<FoundItemView> {
    return await this.items.claim(id, dto, 'gate');
  }
}

/** The register as the management keeps it (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('found_items.manage')
@Controller('staff/security/found-items')
export class StaffFoundItemsController {
  constructor(private readonly items: FoundItemsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({ summary: 'Register a found item at the office' })
  @ApiCreatedResponse({ type: StaffFoundItemView })
  async register(
    @Body() dto: RegisterFoundItemDto,
  ): Promise<StaffFoundItemView> {
    return (await this.items.register(dto, 'office')) as StaffFoundItemView;
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the register', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(StaffFoundItemView) })
  async list(
    @Query() q: FoundItemsQueryDto,
  ): Promise<ListResponse<StaffFoundItemView>> {
    return toList(await this.items.staffList(q), (i) => i);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a found item' })
  @ApiOkResponse({ type: StaffFoundItemView })
  get(@Param('id', parseId()) id: string): Promise<StaffFoundItemView> {
    return this.items.get(id);
  }

  @Post(':id/receive')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a found item from the gate',
    description: 'The management holds it now.',
  })
  @ApiOkResponse({ type: StaffFoundItemView })
  receive(@Param('id', parseId()) id: string): Promise<StaffFoundItemView> {
    return this.items.receive(id);
  }

  @Post(':id/claim')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record its owner’s claim',
    description: 'Held at the gate or at the office; once.',
  })
  @ApiOkResponse({ type: StaffFoundItemView })
  async claim(
    @Param('id', parseId()) id: string,
    @Body() dto: ClaimFoundItemDto,
  ): Promise<StaffFoundItemView> {
    return (await this.items.claim(id, dto, 'office')) as StaffFoundItemView;
  }
}
