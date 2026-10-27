import { Body,CanActivate,Controller,createParamDecorator,ExecutionContext,Get,HttpCode,Inject,Injectable,Module,Post,UnauthorizedException,UseGuards } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Profile,Role } from '../types.js';
import type { IdentityPort } from '../ports/application.js';
import { IDENTITY } from './contracts.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(IDENTITY)private identity:IdentityPort){}
  async canActivate(context:ExecutionContext){
    const request=context.switchToHttp().getRequest();
    request.telecusProfile=await this.identity.authenticate(request.headers.authorization);
    return true;
  }
}
export const CurrentProfile=createParamDecorator((_data:unknown,context:ExecutionContext):Profile=>{
  const user=context.switchToHttp().getRequest().telecusProfile;
  if(!user)throw new UnauthorizedException('Inicia sesión para continuar.');
  return user;
});
@Controller('api')
export class AccessController {
  constructor(@Inject(IDENTITY)private identity:IdentityPort){}
  @Post('auth/demo') @HttpCode(200) demo(@Body()body:{role?:Role}){return this.identity.demoLogin(body?.role as Role);}
  @Get('me') @UseGuards(SessionGuard) me(@CurrentProfile()user:Profile){const {token,...profile}=user;return profile;}
}
@Module({})
export class AccessModule {
  static register(identity:IdentityPort):DynamicModule{return {module:AccessModule,controllers:[AccessController],providers:[{provide:IDENTITY,useValue:identity},SessionGuard],exports:[IDENTITY,SessionGuard]};}
}
