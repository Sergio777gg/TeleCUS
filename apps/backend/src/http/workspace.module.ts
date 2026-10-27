import {Body,Controller,Get,HttpCode,Inject,Module,Post,Query,UseGuards} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import type {Profile} from '../types.js';
import type {WorkspaceService} from '../application/workspace.js';
import {CurrentProfile,SessionGuard} from './access.module.js';
export const WORKSPACE=Symbol('telecus.workspace');
@Controller('api/workspace') @UseGuards(SessionGuard)
export class WorkspaceController {
  constructor(@Inject(WORKSPACE)private workspace:WorkspaceService){}
  @Get('appointments') appointments(@CurrentProfile()actor:Profile,@Query()filter:Record<string,string>){return this.workspace.appointments(actor,filter);}
  @Get('requests') requests(@CurrentProfile()actor:Profile,@Query()filter:Record<string,string>){return this.workspace.requests(actor,filter);}
  @Get('doctors') doctors(@CurrentProfile()actor:Profile){return this.workspace.doctors(actor);}
  @Get('availability') availability(@CurrentProfile()actor:Profile,@Query('doctor')doctor:string,@Query('date')date:string){return this.workspace.availability(actor,doctor,date);}
  @Get('information') information(@CurrentProfile()actor:Profile){return this.workspace.information(actor);}
  @Get('usage') usage(@CurrentProfile()actor:Profile){return this.workspace.usage(actor);}
  @Post('reviews') @HttpCode(200) prepare(@CurrentProfile()actor:Profile,@Body()body:unknown){return this.workspace.prepare(actor,body);}
  @Post('actions') @HttpCode(200) action(@CurrentProfile()actor:Profile,@Body()body:unknown){return this.workspace.action(actor,body);}
}
@Module({})
export class WorkspaceModule {
  static register(access:DynamicModule,service:WorkspaceService):DynamicModule{
    return {module:WorkspaceModule,imports:[access],controllers:[WorkspaceController],providers:[{provide:WORKSPACE,useValue:service}]};
  }
}
