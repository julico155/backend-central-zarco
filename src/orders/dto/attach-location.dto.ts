import { IsLatitude, IsLongitude, IsString, Matches } from 'class-validator';

export class AttachLocationDto {
  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  @IsString()
  @Matches(/\S/)
  dropoffAddress!: string;
}
