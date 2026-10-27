import {Controller,Get,Inject,Module,Query,UseGuards} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import type {Profile} from '../types.js';
import type {PatientWorkspaceService} from '../application/patient-workspace.js';
import {CurrentProfile,SessionGuard} from './access.module.js';
const PATIENT=Symbol('telecus.patient-workspace');
@Controller('api/patient') @UseGuards(SessionGuard)
class PatientWorkspaceController {
 constructor(@Inject(PATIENT)private service:PatientWorkspaceService){}
 @Get('appointments') read(@CurrentProfile()actor:Profile,@Query('code')code?:string){return this.service.read(actor,code);}
}
@Module({}) export class PatientWorkspaceModule {static register(access:DynamicModule,service:PatientWorkspaceService):DynamicModule{return {module:PatientWorkspaceModule,imports:[access],controllers:[PatientWorkspaceController],providers:[{provide:PATIENT,useValue:service}]};}}
