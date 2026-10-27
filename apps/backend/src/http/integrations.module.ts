import { Controller,Get,Inject,Module,UseGuards } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Profile } from '../types.js';
import { CurrentProfile,SessionGuard } from './access.module.js';
import { DELIVERY_QUERIES } from './contracts.js';
import type { DeliveryQueries } from './contracts.js';

@Controller('api/integrations') @UseGuards(SessionGuard)
export class IntegrationsController {
  constructor(@Inject(DELIVERY_QUERIES)private deliveries:DeliveryQueries){}
  @Get('deliveries') list(@CurrentProfile()user:Profile){return this.deliveries.list(user);}
}
@Module({})
export class IntegrationsModule {
  static register(access:DynamicModule,deliveries:DeliveryQueries):DynamicModule{return {module:IntegrationsModule,imports:[access],controllers:[IntegrationsController],providers:[{provide:DELIVERY_QUERIES,useValue:deliveries}]};}
}
