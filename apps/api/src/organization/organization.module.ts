import { Module } from '@nestjs/common';
import { OrgUnitsController } from './org-units.controller.js';
import { OrgUnitsService } from './org-units.service.js';

/** A hospital's structure: its facilities, departments and units. */
@Module({
  controllers: [OrgUnitsController],
  providers: [OrgUnitsService],
  // For the areas that let someone pick a unit: users, role grants, incidents.
  exports: [OrgUnitsService],
})
export class OrganizationModule {}
