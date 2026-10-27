import { Body,Controller,Get,HttpCode,Inject,Module,Post,Query,UseGuards,ServiceUnavailableException } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Profile } from '../types.js';
import { CurrentProfile,SessionGuard } from './access.module.js';
import { NOTIFICATIONS } from './contracts.js';
import type { NotificationRequests } from './contracts.js';

@Controller('api/notifications') @UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(NOTIFICATIONS)private notifications:NotificationRequests){}
  @Get() list(@CurrentProfile()user:Profile,@Query('before')before?:string,@Query('limit')limit?:string){return this.notifications.list(user,before,limit===undefined?20:Number(limit));}
  @Post('read') @HttpCode(200) read(@CurrentProfile()user:Profile,@Body()body:{ids?:unknown}){return this.notifications.read(user,body?.ids);}
  @Post('remove') @HttpCode(200) remove(@CurrentProfile()user:Profile,@Body()body:unknown){if(!this.notifications.remove)throw new ServiceUnavailableException();return this.notifications.remove(user,body);}
  @Post('restore') @HttpCode(200) restore(@CurrentProfile()user:Profile,@Body()body:unknown){if(!this.notifications.restore)throw new ServiceUnavailableException();return this.notifications.restore(user,body);}
}
@Module({})
export class NotificationsModule {
  static register(access:DynamicModule,notifications:NotificationRequests):DynamicModule{return {module:NotificationsModule,imports:[access],controllers:[NotificationsController],providers:[{provide:NOTIFICATIONS,useValue:notifications}]};}
}
