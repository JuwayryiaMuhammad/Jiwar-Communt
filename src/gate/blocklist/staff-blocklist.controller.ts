import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { BlocklistService } from './blocklist.service';
import {
  BlocklistQueryDto,
  CreateBlocklistEntryDto,
  LiftBlocklistEntryDto,
  UpdateBlocklistEntryDto,
} from './dto/blocklist.dto';
import { StaffBlocklistEntryView } from './views/blocklist.views';

/** The blocklist and the watchlist, kept by `blocklist.manage` (ADR 0053). */
@ApiArea('blocklist')
@RequirePermissions('blocklist.manage')
@Controller('staff/security/blocklist')
export class StaffBlocklistController {
  constructor(private readonly blocklist: BlocklistService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the blocklist', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(StaffBlocklistEntryView) })
  async list(
    @Query() q: BlocklistQueryDto,
  ): Promise<ListResponse<StaffBlocklistEntryView>> {
    return toList(await this.blocklist.list(q), (r) =>
      StaffBlocklistEntryView.from(r),
    );
  }

  @Post()
  @NoStore()
  @Idempotent({ omit: ['idNumber'], secret: true })
  @ApiOperation({
    summary: 'Ban or watch a plate or a person',
    description:
      'A plate, or a person (a name, their full ID number, a face). The ID number is kept only as a keyed hash: nobody sees it again; the request’s idempotency record leaves it out and stores no body (a replay is rendered afresh). One live entry per plate and per person (409 DUPLICATE_RESOURCE).',
  })
  @ApiCreatedResponse({ type: StaffBlocklistEntryView })
  async create(
    @Body() dto: CreateBlocklistEntryDto,
  ): Promise<StaffBlocklistEntryView> {
    return StaffBlocklistEntryView.from(await this.blocklist.create(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a blocklist entry' })
  @ApiOkResponse({ type: StaffBlocklistEntryView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffBlocklistEntryView> {
    return StaffBlocklistEntryView.from(await this.blocklist.get(id));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Change what a live entry says',
    description:
      'Its kind, reason, note, expiry or face; never its plate or person. A lifted one changes no more (BLOCKLIST_ENTRY_LIFTED).',
  })
  @ApiOkResponse({ type: StaffBlocklistEntryView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateBlocklistEntryDto,
  ): Promise<StaffBlocklistEntryView> {
    return StaffBlocklistEntryView.from(await this.blocklist.update(id, dto));
  }

  @Post(':id/lift')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Lift an entry',
    description:
      'With a code from `blocklistLift`. A person’s name, ID hash, face and note go 30 days later.',
  })
  @ApiOkResponse({ type: StaffBlocklistEntryView })
  async lift(
    @Param('id', parseId()) id: string,
    @Body() dto: LiftBlocklistEntryDto,
  ): Promise<StaffBlocklistEntryView> {
    return StaffBlocklistEntryView.from(
      await this.blocklist.lift(id, dto.reasonCode),
    );
  }
}
