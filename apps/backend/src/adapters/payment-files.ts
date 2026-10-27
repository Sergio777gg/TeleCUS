import { createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,randomUUID } from 'node:crypto';
import { lstat,mkdir,open,readFile,rename,rmdir,unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import type { PaymentBlobStore } from '../ports/payments.js';

const magic=Buffer.from('TCUS-PAY1'),maxBytes=5*1024*1024,overhead=magic.length+12+16;
/** Private encrypted objects; the API must authorize metadata before asking for a file. */
export class LocalPaymentBlobStore implements PaymentBlobStore {
  private root:string;private secret:Buffer;
  constructor(directory:string,secret:string,namespace='telecus/payment-receipts/v1'){
    if(secret.length<32)throw new Error('Falta una clave estable para los comprobantes privados.');
    this.root=resolve(directory);this.secret=createHmac('sha256',secret).update(namespace).digest();
  }
  private object(key:string){if(!/^[0-9a-f]{64}$/.test(key))throw new Error('Identificador privado no válido.');return join(this.root,key.slice(0,2),key,'content.enc');}
  private async directory(key:string){
    this.object(key);await mkdir(this.root,{recursive:true,mode:0o700});
    const root=await lstat(this.root);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('El almacenamiento privado no es un directorio ordinario.');
    const bucket=join(this.root,key.slice(0,2));await mkdir(bucket,{recursive:true,mode:0o700});
    const entry=await lstat(bucket);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('Directorio privado no válido.');return bucket;
  }
  async get(key:string):Promise<Buffer>{
    const file=this.object(key);
    for(const directory of [this.root,join(this.root,key.slice(0,2)),join(this.root,key.slice(0,2),key)]){const folder=await lstat(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('Directorio privado no válido.');}
    const entry=await lstat(file);
    if(!entry.isFile()||entry.isSymbolicLink()||entry.size<=overhead||entry.size>maxBytes+overhead)throw new Error('Archivo privado no válido.');
    const bytes=await readFile(file);
    if(!bytes.subarray(0,magic.length).equals(magic))throw new Error('Formato privado no válido.');
    const decipher=createDecipheriv('aes-256-gcm',this.secret,bytes.subarray(magic.length,magic.length+12));
    decipher.setAAD(Buffer.from(key,'hex'));decipher.setAuthTag(bytes.subarray(magic.length+12,overhead));
    return Buffer.concat([decipher.update(bytes.subarray(overhead)),decipher.final()]);
  }
  async put(key:string,data:Buffer,sha256:string):Promise<void>{
    if(!Buffer.isBuffer(data)||!data.length||data.length>maxBytes||createHash('sha256').update(data).digest('hex')!==sha256)throw new Error('Contenido privado no válido.');
    const bucket=await this.directory(key),destination=join(bucket,key),temporary=join(bucket,key+'.'+randomUUID()+'.tmp');let created=false,moved=false;
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.secret,iv);cipher.setAAD(Buffer.from(key,'hex'));
    const encrypted=Buffer.concat([cipher.update(data),cipher.final()]),content=Buffer.concat([magic,iv,cipher.getAuthTag(),encrypted]);
    try{
      await mkdir(temporary,{mode:0o700});created=true;
      const handle=await open(join(temporary,'content.enc'),'wx',0o600);
      try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
      // A populated object directory cannot be replaced by another rename. Readers
      // see the complete encrypted file, including on Windows without hard links.
      try{await rename(temporary,destination);moved=true;}catch(error:any){
        if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code))throw error;
        const existing=await this.get(key);if(createHash('sha256').update(existing).digest('hex')!==sha256)throw new Error('El objeto privado existente tiene otro contenido.');
      }
    }finally{if(created&&!moved){await unlink(join(temporary,'content.enc')).catch(()=>{});await rmdir(temporary).catch(()=>{});}}
  }
}
