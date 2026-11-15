import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { ExtrasController } from './extras.controller';
import { ExtrasService } from './extras.service';

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [ExtrasController],
  providers: [ExtrasService],
  exports: [ExtrasService],
})
export class ExtrasModule {}
