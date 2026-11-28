import { Global, Module } from '@nestjs/common';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiService } from './ai.service.js';
import { AiProviders } from './providers.js';

/**
 * The AI foundation (docs/specs/ai-providers-and-allowances.md): the one
 * provider interface and its adapters, the client's settings, and
 * `AiService.run()`, the single entry point every AI feature calls. Global,
 * like the identity module, so that any feature can ask it; the admin
 * portal's routes for it are in the platform module.
 */
@Global()
@Module({
  controllers: [AiSettingsController],
  providers: [AiService, AiProviders],
  exports: [AiService, AiProviders],
})
export class AiModule {}
