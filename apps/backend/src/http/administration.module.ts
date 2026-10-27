import {Body,Controller,Get,HttpCode,Inject,Module,Param,Post,Query,UseGuards} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import type {Profile} from '../types.js';
import type {AdministrationService} from '../application/administration.js';
import {CurrentProfile,SessionGuard} from './access.module.js';
export const ADMINISTRATION=Symbol('telecus.administration');
@Controller('api/admin') @UseGuards(SessionGuard)
export class AdministrationController {
  constructor(@Inject(ADMINISTRATION)private service:AdministrationService){}
  @Post('commands') @HttpCode(200) write(@CurrentProfile()user:Profile,@Body()body:any){return this.service.write(user,body);}
  @Post('knowledge/preview') @HttpCode(200) preview(@CurrentProfile()user:Profile,@Body()body:any){return this.service.preview(user,body);}
  @Post('payments/:id/review') @HttpCode(200) prepare(@CurrentProfile()user:Profile,@Param('id')id:string,@Body()body:{requestId?:unknown}){return this.service.prepareReview(user,id,body?.requestId);}
  @Post('payment-reviews/:id/confirm') @HttpCode(200) confirm(@CurrentProfile()user:Profile,@Param('id')id:string,@Body()body:{verified?:unknown}){return this.service.confirmReview(user,id,body?.verified);}
  @Get(':resource') read(@CurrentProfile()user:Profile,@Param('resource')resource:string,@Query()query:Record<string,string>){return this.service.read(user,resource,query);}
}
@Module({})
export class AdministrationModule {
  static register(access:DynamicModule,service:AdministrationService):DynamicModule{return {module:AdministrationModule,imports:[access],controllers:[AdministrationController],providers:[{provide:ADMINISTRATION,useValue:service}]};}
}
