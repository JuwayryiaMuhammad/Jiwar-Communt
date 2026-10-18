import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class TurnOnChildControlDto {
  @ApiProperty({
    type: Boolean,
    description: 'Whether the child may leave the compound alone.',
  })
  @IsBoolean()
  mayLeaveAlone: boolean;

  @ApiProperty({
    type: Boolean,
    description: 'Whether the household is told of each exit.',
  })
  @IsBoolean()
  notifyPickups: boolean;
}

export class UpdateChildControlDto {
  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  mayLeaveAlone?: boolean;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  notifyPickups?: boolean;
}

export class ChildPhotoDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'One of your finalized `child_photo` files.',
  })
  @IsUUID()
  fileId: string;
}
