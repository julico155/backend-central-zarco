import { PartialType } from '@nestjs/swagger';
import { CreateExtraDto } from './create-extra.dto';

export class UpdateExtraDto extends PartialType(CreateExtraDto) {}
