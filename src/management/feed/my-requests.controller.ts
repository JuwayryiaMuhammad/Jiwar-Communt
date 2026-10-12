import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { ManagementRequestType } from '@prisma/client';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { MyRequestsService, type MyRequest } from './my-requests.service';

const SOURCES = ['maintenance', 'management'] as const;

/** A row of "all my requests": codes and times, never what was written. */
export class MyRequestView {
  @ApiProperty({
    enum: SOURCES,
    description:
      '`maintenance`: a ticket (`/tickets/{id}`). `management`: a request to the management (`/management-requests/{id}`).',
  })
  type: (typeof SOURCES)[number];
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MR-000123' })
  number: string;
  @ApiProperty({
    type: String,
    description:
      'The item’s own status: a TicketStatus for a ticket, a ManagementRequestStatus for a request.',
  })
  status: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'What the list is ordered by, newest first.',
  })
  lastActivityAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A ticket’s category key; null for a request.',
  })
  categoryKey: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A request’s topic key; null for a ticket.',
  })
  topicKey: string | null;
  @ApiProperty({
    enum: ManagementRequestType,
    enumName: 'ManagementRequestType',
    nullable: true,
    description: 'A request’s kind; null for a ticket.',
  })
  requestType: ManagementRequestType | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;

  static from(r: MyRequest): MyRequestView {
    return {
      type: r.type,
      id: r.id,
      number: r.number,
      status: r.status,
      lastActivityAt: r.lastActivityAt,
      categoryKey: r.categoryKey,
      topicKey: r.topicKey,
      requestType: r.requestType,
      unitId: r.unitId,
    };
  }
}

/**
 * Everything the resident has asked for, in one list (ADR 0039): their
 * management requests and the maintenance tickets they can see.
 */
@ApiArea('management-requests')
@RequireAnyPermission('requests.create', 'tickets.create')
@Controller('me/requests')
export class MyRequestsController {
  constructor(private readonly feed: MyRequestsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List all my requests: tickets and requests to the management',
  })
  @ApiOkResponse({ type: ListOf(MyRequestView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<MyRequestView>> {
    return toList(await this.feed.list(q), (r) => MyRequestView.from(r));
  }
}
