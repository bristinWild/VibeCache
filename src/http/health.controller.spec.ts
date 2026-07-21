import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get(HealthController);
  });

  it('reports the API health and version', () => {
    expect(controller.getHealth()).toEqual({
      name: 'vibecache',
      status: 'ok',
      version: '0.1.0',
    });
  });
});
