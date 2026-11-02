import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import type { RequestReplyTemplate } from '@prisma/client';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  REPLY_TEMPLATE_BODY,
  REPLY_TEMPLATE_NAME,
  ReplyTemplatesService,
} from './reply-templates.service';

const BODY = { min: REPLY_TEMPLATE_BODY.min, max: REPLY_TEMPLATE_BODY.max };

class ReplyTemplateWordsDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'A topic of the compound; null for any topic.',
  })
  @IsOptional()
  @IsUUID()
  topicId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: BODY.min,
    maxLength: BODY.max,
    description: 'English, Arabic or both: at least one.',
  })
  @IsOptional()
  @IsString()
  @Length(BODY.min, BODY.max, withParams(BODY))
  bodyEn?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: BODY.min,
    maxLength: BODY.max,
  })
  @IsOptional()
  @IsString()
  @Length(BODY.min, BODY.max, withParams(BODY))
  bodyAr?: string | null;
}

export class CreateReplyTemplateDto extends ReplyTemplateWordsDto {
  @ApiProperty({
    type: String,
    minLength: REPLY_TEMPLATE_NAME.min,
    maxLength: REPLY_TEMPLATE_NAME.max,
    description: 'The compound’s own, once (DUPLICATE_RESOURCE).',
  })
  @IsString()
  @Length(
    REPLY_TEMPLATE_NAME.min,
    REPLY_TEMPLATE_NAME.max,
    withParams(REPLY_TEMPLATE_NAME),
  )
  name: string;
}

export class UpdateReplyTemplateDto extends ReplyTemplateWordsDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: REPLY_TEMPLATE_NAME.min,
    maxLength: REPLY_TEMPLATE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    REPLY_TEMPLATE_NAME.min,
    REPLY_TEMPLATE_NAME.max,
    withParams(REPLY_TEMPLATE_NAME),
  )
  name?: string;
}

export class ReplyTemplatesQueryDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A topic’s templates and those for any topic.',
  })
  @IsOptional()
  @IsUUID()
  topicId?: string;
}

export class ReplyTemplateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null: for any topic.',
  })
  topicId: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: RequestReplyTemplate): ReplyTemplateView {
    return {
      id: t.id,
      name: t.name,
      topicId: t.topicId,
      bodyEn: t.bodyEn,
      bodyAr: t.bodyAr,
      updatedAt: t.updatedAt,
    };
  }
}

/**
 * Reply templates for the queue (ADR 0080): read by whoever handles
 * requests, written by `requests.manage`.
 */
@ApiArea('management-requests')
@RequirePermissions('requests.handle')
@Controller('management/reply-templates')
export class ReplyTemplatesController {
  constructor(private readonly templates: ReplyTemplatesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the reply templates' })
  @ApiOkResponse({ type: ListOf(ReplyTemplateView) })
  async list(
    @Query() q: ReplyTemplatesQueryDto,
  ): Promise<ListResponse<ReplyTemplateView>> {
    return bounded(await this.templates.list(q.topicId), (t) =>
      ReplyTemplateView.from(t),
    );
  }

  @Post()
  @NoStore()
  @RequirePermissions('requests.manage')
  @ApiOperation({ summary: 'Add a reply template' })
  @ApiCreatedResponse({ type: ReplyTemplateView })
  async create(
    @Body() dto: CreateReplyTemplateDto,
  ): Promise<ReplyTemplateView> {
    return ReplyTemplateView.from(await this.templates.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @RequirePermissions('requests.manage')
  @ApiOperation({ summary: 'Change a reply template' })
  @ApiOkResponse({ type: ReplyTemplateView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateReplyTemplateDto,
  ): Promise<ReplyTemplateView> {
    return ReplyTemplateView.from(await this.templates.update(id, dto));
  }

  @Delete(':id')
  @NoStore()
  @RequirePermissions('requests.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a reply template' })
  @ApiNoContentResponse()
  async delete(@Param('id', parseId()) id: string): Promise<void> {
    await this.templates.delete(id);
  }
}
