import { BadRequestException,Body,Controller,ForbiddenException,Get,Header,Headers,HttpCode,HttpException,Inject,Injectable,Module,Param,Post,ServiceUnavailableException,StreamableFile,UploadedFile,UseGuards,UseInterceptors } from '@nestjs/common';
import type { CallHandler,DynamicModule,ExecutionContext,NestInterceptor } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Profile } from '../types.js';
import { CurrentProfile,SessionGuard } from './access.module.js';
import { PAYMENTS } from './contracts.js';
import type { PaymentRequests } from './contracts.js';

/** Bound buffered file requests per process; authorization runs before multipart parsing. */
@Injectable()
export class PaymentFileCapacity implements NestInterceptor {
  private active=new Set<string>();
  intercept(context:ExecutionContext,next:CallHandler){
    const request=context.switchToHttp().getRequest(),user:Profile=request.telecusProfile;
    if(!['PATIENT','ADMIN'].includes(user.role)||(request.method==='POST'&&user.role!=='PATIENT'))throw new ForbiddenException('Tu rol no permite esta operación con comprobantes.');
    if(request.method==='POST'&&(typeof request.headers['idempotency-key']!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.headers['idempotency-key'])))throw new BadRequestException('Falta el identificador de envío. Vuelve a seleccionar el archivo.');
    if(this.active.size>=4||this.active.has(user.id))throw new HttpException('Hay otro archivo en proceso. Espera un momento e inténtalo de nuevo.',429);
    this.active.add(user.id);
    const response=context.switchToHttp().getResponse();let released=false;
    const release=()=>{if(released)return;released=true;this.active.delete(user.id);response.removeListener('finish',release);response.removeListener('close',release);request.removeListener('aborted',release);};
    response.once('finish',release);response.once('close',release);request.once('aborted',release);
    try{return next.handle();}catch(error){release();throw error;}
  }
}

@Controller('api/payments') @UseGuards(SessionGuard)
export class PaymentsController {
  constructor(@Inject(PAYMENTS)private payments:PaymentRequests){}
  @Post('receipts/:id/withdraw') @HttpCode(200)
  withdraw(@CurrentProfile()user:Profile,@Param('id')id:string,@Body()body:{requestId?:unknown}){
    if(!this.payments.withdraw)throw new ServiceUnavailableException('La corrección de comprobantes aún no está habilitada.');
    return this.payments.withdraw(user,id,body?.requestId);
  }
  @Get() list(@CurrentProfile()user:Profile){return this.payments.list(user);}
  @Post(':appointmentId/receipt') @HttpCode(200)
  @UseInterceptors(PaymentFileCapacity,FileInterceptor('file',{limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}}))
  upload(@CurrentProfile()user:Profile,@Param('appointmentId')appointmentId:string,@Headers('idempotency-key')requestId:string,@UploadedFile()file?:{buffer:Buffer;originalname:string;mimetype:string}){
    if(!file)throw new BadRequestException('Selecciona el comprobante que deseas adjuntar.');
    return this.payments.upload(user,appointmentId,requestId,{file_name:file.originalname,content_type:file.mimetype,data:file.buffer});
  }
  @Get('receipts/:id') @Header('Cache-Control','no-store') @Header('X-Content-Type-Options','nosniff') @UseInterceptors(PaymentFileCapacity) async download(@CurrentProfile()user:Profile,@Param('id')id:string){
    const file=await this.payments.download(user,id);
    return new StreamableFile(file.data,{type:'application/octet-stream',disposition:`attachment; filename="comprobante${file.content_type==='application/pdf'?'.pdf':file.content_type==='image/png'?'.png':'.jpg'}"`,length:file.data.length});
  }
}
@Module({})
export class PaymentsModule {
  static register(access:DynamicModule,payments:PaymentRequests):DynamicModule{return {module:PaymentsModule,imports:[access],controllers:[PaymentsController],providers:[{provide:PAYMENTS,useValue:payments},PaymentFileCapacity]};}
}
