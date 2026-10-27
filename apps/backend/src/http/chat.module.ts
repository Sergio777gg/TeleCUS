import { Body,Controller,Get,Headers,HttpCode,Inject,Module,Param,Post,UseGuards,ForbiddenException } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Profile } from '../types.js';
import { validateInput } from '../application/chat-input.js';
import { CurrentProfile,SessionGuard } from './access.module.js';
import { CHAT } from './contracts.js';
import type { ChatRequests } from './contracts.js';

@Controller('api/chat/jobs') @UseGuards(SessionGuard)
export class ChatController {
  constructor(@Inject(CHAT)private chat:ChatRequests){}
  @Post() @HttpCode(202) enqueue(@CurrentProfile()user:Profile,@Headers('authorization')authorization:string,@Body()body:unknown){if(user.role!=='PATIENT')throw new ForbiddenException('Los médicos y administradores utilizan los paneles de gestión, no el chatbot.');return this.chat.enqueue(user,validateInput(body),authorization);}
  @Get(':id') get(@CurrentProfile()user:Profile,@Param('id')id:string){return this.chat.get(user,id);}
}
@Module({})
export class ChatModule {
  static register(access:DynamicModule,chat:ChatRequests):DynamicModule{return {module:ChatModule,imports:[access],controllers:[ChatController],providers:[{provide:CHAT,useValue:chat}]};}
}
