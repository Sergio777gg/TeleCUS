import { Controller,Get,Inject,Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { SYSTEM_QUERIES } from './contracts.js';
import type { SystemQueries } from './contracts.js';

@Controller('api')
export class SystemController {
  constructor(@Inject(SYSTEM_QUERIES)private system:SystemQueries){}
  @Get('config') configuration(){return this.system.configuration();}
  @Get('healthz') health(){return this.system.health();}
}
@Module({})
export class SystemModule {
  static register(system:SystemQueries):DynamicModule{return {module:SystemModule,controllers:[SystemController],providers:[{provide:SYSTEM_QUERIES,useValue:system}]};}
}
