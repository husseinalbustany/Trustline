import './env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { listen, setupApp } from './app.setup.js';
import { DeadlineCheck } from './incidents/deadline-check.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  // Versioned so web and mobile clients on an older release keep working.
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  // On this machine only, unless API_HOST says otherwise; and said in the
  // log, with how far the forwarding header is trusted: see app.setup.ts.
  await listen(app);
  // The check behind the "due soon" and "overdue" notifications, every five
  // minutes. Started here and nowhere else, so nothing that merely builds
  // the application (a test, a script) runs it. Safe in every API process
  // at once; it stops with the application.
  app.get(DeadlineCheck, { strict: false }).start();
}
await bootstrap();
