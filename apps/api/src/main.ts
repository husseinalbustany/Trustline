import './env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Versioned so web and mobile clients on an older release keep working.
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(process.env.API_PORT ?? 3001);
}
await bootstrap();
