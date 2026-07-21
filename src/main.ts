import { NestFactory } from '@nestjs/core';
import { ApiAppModule } from './api-app.module';

async function bootstrap() {
  const app = await NestFactory.create(ApiAppModule);

  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000, '127.0.0.1');
}

void bootstrap();
