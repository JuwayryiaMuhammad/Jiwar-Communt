import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import type { AnnouncementTemplate } from '@prisma/client';
import { IsOptional, IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { BODY_MAX, TITLE_MAX } from '../announcements/announcements.service';
import {
  AnnouncementTemplatesService,
  TEMPLATE_NAME,
} from './announcement-templates.service';

const TITLE = { min: 1, max: TITLE_MAX };
const BODY = { min: 1, max: BODY_MAX };

const text = (limits: { min: number; max: number }, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: limits.min,
    maxLength: limits.max,
    description,
  });

class TemplateTextDto {
  @text(TITLE, 'A language is whole or absent; at least one is there.')
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(BODY)
  @IsOptional()
  @IsString()
  bodyEn?: string | null;

  @text(TITLE)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(BODY)
  @IsOptional()
  @IsString()
  bodyAr?: string | null;
}

export class CreateAnnouncementTemplateDto extends TemplateTextDto {
  @ApiProperty({
    type: String,
    minLength: TEMPLATE_NAME.min,
    maxLength: TEMPLATE_NAME.max,
    description: 'The compound’s own, once (DUPLICATE_RESOURCE).',
  })
  @IsString()
  @Length(TEMPLATE_NAME.min, TEMPLATE_NAME.max, withParams(TEMPLATE_NAME))
  name: string;
}

export class UpdateAnnouncementTemplateDto extends TemplateTextDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: TEMPLATE_NAME.min,
    maxLength: TEMPLATE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(TEMPLATE_NAME.min, TEMPLATE_NAME.max, withParams(TEMPLATE_NAME))
  name?: string;
}

export class AnnouncementTemplateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: String, nullable: true })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(t: AnnouncementTemplate): AnnouncementTemplateView {
    return {
      id: t.id,
      name: t.name,
      titleEn: t.titleEn,
      bodyEn: t.bodyEn,
      titleAr: t.titleAr,
      bodyAr: t.bodyAr,
      updatedAt: t.updatedAt,
    };
  }
}

/** The compound's announcement templates (ADR 0080, `community.publish`). */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community/announcement-templates')
export class AnnouncementTemplatesController {
  constructor(private readonly templates: AnnouncementTemplatesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the announcement templates' })
  @ApiOkResponse({ type: ListOf(AnnouncementTemplateView) })
  async list(): Promise<ListResponse<AnnouncementTemplateView>> {
    return bounded(await this.templates.list(), (t) =>
      AnnouncementTemplateView.from(t),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Add an announcement template' })
  @ApiCreatedResponse({ type: AnnouncementTemplateView })
  async create(
    @Body() dto: CreateAnnouncementTemplateDto,
  ): Promise<AnnouncementTemplateView> {
    return AnnouncementTemplateView.from(await this.templates.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Change an announcement template' })
  @ApiOkResponse({ type: AnnouncementTemplateView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAnnouncementTemplateDto,
  ): Promise<AnnouncementTemplateView> {
    return AnnouncementTemplateView.from(await this.templates.update(id, dto));
  }

  @Delete(':id')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an announcement template' })
  @ApiNoContentResponse()
  async delete(@Param('id', parseId()) id: string): Promise<void> {
    await this.templates.delete(id);
  }
}
