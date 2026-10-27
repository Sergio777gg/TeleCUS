import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { Runtime } from './runtime.js';
import { ApiModule } from './http/app.module.js';
import { originAllowed } from './origin-policy.js';

if(existsSync('.env'))loadEnvFile('.env');
const require=createRequire(import.meta.url);
async function main(){
  const runtime=new Runtime();await runtime.initialize();
  const shutdown=async()=>{await runtime.close();process.exit(0);};
  if(['worker','delivery-worker'].includes(process.env.PROCESS_KIND||'')){process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);console.log('Trabajador TeleCUS iniciado.');setInterval(()=>{},60000);return;}
  const app=await NestFactory.create<NestExpressApplication>(ApiModule.register(runtime.httpBindings),{bodyParser:false,logger:['error','warn','log']});
  app.use(require('express').json({limit:'32kb'}));
  app.use((req:any,res:any,next:any)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self' https://*.supabase.co; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(req.url.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    if(['POST','PUT','DELETE','PATCH'].includes(req.method)&&req.headers.origin){
      if(!originAllowed(req.headers.origin,runtime.cfg))return res.status(403).json({message:'Origen no permitido.'});
    }
    next();
  });
  const assets=resolve('apps/frontend/dist');if(existsSync(assets))app.useStaticAssets(assets,{index:'index.html',maxAge:0});
  await app.listen(runtime.cfg.port,runtime.cfg.host);
  const close=async()=>{await app.close();await shutdown();};process.on('SIGINT',close);process.on('SIGTERM',close);
  console.log(`TeleCUS: ${runtime.cfg.origin} (${runtime.cfg.mode})`);
}
main().catch(()=>{console.error('TeleCUS no pudo iniciar. Revisa la configuración y los puertos disponibles.');process.exit(1);});
