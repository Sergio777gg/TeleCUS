import {BadRequestException,Body,Controller,Get,Header,Headers,HttpCode,HttpException,Inject,Injectable,Module,Param,Post,Query,StreamableFile,UploadedFile,UseGuards,UseInterceptors,ForbiddenException} from '@nestjs/common';
import type {DynamicModule,ExecutionContext,CallHandler,NestInterceptor} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import type {Profile} from '../types.js';
import type {ClinicalDocumentService} from '../application/clinical-documents.js';
import {CurrentProfile,SessionGuard} from './access.module.js';
const CLINICAL=Symbol('telecus.clinical');
@Injectable()
class ClinicalFileCapacity implements NestInterceptor {
 private active=new Set<string>();
 intercept(context:ExecutionContext,next:CallHandler){
  const request=context.switchToHttp().getRequest(),response=context.switchToHttp().getResponse(),user:Profile=request.telecusProfile;
  if(!['PATIENT','DOCTOR'].includes(user.role)||request.method==='POST'&&user.role!=='PATIENT')throw new ForbiddenException();
  if(request.method==='POST'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.headers['idempotency-key']||''))throw new BadRequestException('Falta la referencia del envío.');
  if(this.active.size>=4||this.active.has(user.id))throw new HttpException('Hay otro documento en proceso. Espera un momento.',429);
  this.active.add(user.id);let released=false;const release=()=>{if(released)return;released=true;this.active.delete(user.id);response.removeListener('finish',release);response.removeListener('close',release);request.removeListener('aborted',release);};response.once('finish',release);response.once('close',release);request.once('aborted',release);try{return next.handle();}catch(e){release();throw e;}
 }
}
@Controller('api/clinical-documents') @UseGuards(SessionGuard)
class ClinicalDocumentsController {
 constructor(@Inject(CLINICAL)private service:ClinicalDocumentService){}
 @Get() list(@CurrentProfile()actor:Profile,@Query('appointment')appointment?:string){return this.service.list(actor,appointment);}
 @Post(':appointment/attachments') @HttpCode(200) @UseInterceptors(ClinicalFileCapacity,FileInterceptor('file',{limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}}))
 upload(@CurrentProfile()actor:Profile,@Param('appointment')appointment:string,@Headers('idempotency-key')key:string,@UploadedFile()file?:{buffer:Buffer;originalname:string;mimetype:string}){if(!file)throw new BadRequestException('Selecciona el documento.');return this.service.upload(actor,appointment,key,{file_name:file.originalname,content_type:file.mimetype,data:file.buffer});}
 @Get('files/:id') @Header('Cache-Control','no-store') @Header('X-Content-Type-Options','nosniff') @UseInterceptors(ClinicalFileCapacity)
 async download(@CurrentProfile()actor:Profile,@Param('id')id:string){const file=await this.service.download(actor,id);return new StreamableFile(file.data,{type:'application/octet-stream',disposition:'attachment; filename="documento'+(file.content_type==='application/pdf'?'.pdf':file.content_type==='image/png'?'.png':'.jpg')+'"',length:file.data.length});}
 @Post('files/:id/withdraw') @HttpCode(200) withdraw(@CurrentProfile()actor:Profile,@Param('id')id:string){return this.service.withdraw(actor,id);}
 @Post('files/:id/review') @HttpCode(200) review(@CurrentProfile()actor:Profile,@Param('id')id:string,@Body()input:unknown){return this.service.review(actor,id,input);}
}
@Module({}) export class ClinicalDocumentsModule {static register(access:DynamicModule,service:ClinicalDocumentService):DynamicModule{return {module:ClinicalDocumentsModule,imports:[access],controllers:[ClinicalDocumentsController],providers:[{provide:CLINICAL,useValue:service},ClinicalFileCapacity]};}}
