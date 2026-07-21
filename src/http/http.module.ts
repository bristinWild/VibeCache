import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { CapsulesController } from './capsules.controller';
import { HealthController } from './health.controller';
import { ProjectsController } from './projects.controller';

@Module({
  imports: [CoreModule],
  controllers: [HealthController, ProjectsController, CapsulesController],
})
export class HttpModule {}
