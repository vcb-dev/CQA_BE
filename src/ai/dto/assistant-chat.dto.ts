import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssistantHistoryItemDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content: string;
}

export class AssistantRecentMessageDto {
  @ApiProperty({ example: 'customer' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sender: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text: string;
}

export class AssistantConversationContextDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pageName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fromAd?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  labels?: string[];

  @ApiPropertyOptional({ type: [AssistantRecentMessageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => AssistantRecentMessageDto)
  recentMessages?: AssistantRecentMessageDto[];
}

export class AssistantChatDto {
  @ApiProperty({ example: 'Nên hỏi nhu cầu khách này thế nào?' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;

  @ApiPropertyOptional({ type: [AssistantHistoryItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistantHistoryItemDto)
  history?: AssistantHistoryItemDto[];

  @ApiPropertyOptional({ type: AssistantConversationContextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantConversationContextDto)
  conversationContext?: AssistantConversationContextDto;
}
