import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReplyIgCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2200)
  message!: string;
}
