import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID } from 'class-validator';

export class BudgetVsActualQueryDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A budget; by default the active one of the year asked.',
  })
  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @ApiProperty({
    type: Number,
    required: false,
    description: 'The fiscal year, by default the one under way.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fiscalYear?: number;
}
