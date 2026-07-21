import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  name: 'vibecache';
  status: 'ok';
  version: '0.1.0';
}

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      name: 'vibecache',
      status: 'ok',
      version: '0.1.0',
    };
  }
}
