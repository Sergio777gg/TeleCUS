import {WorkspaceModule} from './workspace.module.js';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { HttpBindings } from './contracts.js';
import { AccessModule } from './access.module.js';
import { ChatModule } from './chat.module.js';
import { NotificationsModule } from './notifications.module.js';
import { IntegrationsModule } from './integrations.module.js';
import { SystemModule } from './system.module.js';
import { AdministrationModule } from './administration.module.js';
import { PaymentsModule } from './payments.module.js';
import {ClinicalDocumentsModule} from './clinical-documents.module.js';
import {PatientWorkspaceModule} from './patient-workspace.module.js';

@Module({})
export class ApiModule {
  static register(bindings:HttpBindings):DynamicModule{
    const access=AccessModule.register(bindings.identity),patient=bindings.patientWorkspace?[PatientWorkspaceModule.register(access,bindings.patientWorkspace)]:[];
    return {module:ApiModule,imports:[access,...patient,...(bindings.clinicalDocuments?[ClinicalDocumentsModule.register(access,bindings.clinicalDocuments)]:[]),...(bindings.workspace?[WorkspaceModule.register(access,bindings.workspace)]:[]),ChatModule.register(access,bindings.chat),NotificationsModule.register(access,bindings.notifications),IntegrationsModule.register(access,bindings.deliveries),SystemModule.register(bindings.system),...(bindings.payments?[PaymentsModule.register(access,bindings.payments)]:[]),...(bindings.administration?[AdministrationModule.register(access,bindings.administration)]:[])]};
  }
}
