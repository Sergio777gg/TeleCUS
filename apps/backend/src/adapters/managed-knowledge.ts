import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException} from '@nestjs/common';
import {KnowledgeIndex} from '../knowledge.js';
import type {KnowledgeCatalog,KnowledgeDocument,AdministrationStore} from '../ports/administration.js';
import type {Role} from '../types.js';
export class FileKnowledgeCatalog implements KnowledgeCatalog {
  private entries:KnowledgeDocument[];
  constructor(private directory:string){
    const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    const index=new KnowledgeIndex(directory);
    this.entries=manifest.documents.map((d:any)=>{const source=readFileSync(join(directory,d.file),'utf8'),header=source.match(/^---\r?\n[\s\S]*?\r?\n---/);return {file:d.file,title:d.title,roles:[...new Set(index.chunks.filter(c=>c.file===d.file).flatMap(c=>c.roles))],body:source.slice(header?.[0].length||0).trim()};});
  }
  documents(){return this.entries.map(d=>({...d,roles:[...d.roles]}));}
  validate(file:string,body:string){
    if(!this.entries.some(d=>d.file===file)||body.length>20000||body.trim().length<10||body.startsWith('---')||body.includes('\0'))throw new BadRequestException('Documento o contenido no válido. Edita solo el cuerpo del documento conocido.');
    if(body.split(/(?=^# )/m).some(section=>section.length>4500))throw new BadRequestException('Cada sección debe tener como máximo 4500 caracteres; separa las secciones con un título de primer nivel.');
    new KnowledgeIndex(this.directory,[{file,body,version:'borrador'}]);
  }
  preview(file:string,body:string,query:string,role:Role){
    this.validate(file,body);
    return {role,sources:new KnowledgeIndex(this.directory,[{file,body,version:'borrador'}]).search(query,role).map(c=>({file:c.file,title:c.title,text:c.text,version:c.version})),notice:'Vista de recuperación por audiencia. No publica contenido ni evalúa la respuesta del modelo.'};
  }
}
/** Published corpus is authoritative in Supabase; cached only for a short bounded interval. */
export class ManagedKnowledgeSearch {
  private index:KnowledgeIndex;private signature='';private until=0;private loading?:Promise<void>;
  constructor(private directory:string,private store:AdministrationStore){this.index=new KnowledgeIndex(directory);}
  async search(question:string,role:Role){
    if(Date.now()>=this.until){
      this.loading??=(async()=>{const docs=await this.store.published(),signature=JSON.stringify(docs.map(d=>[d.file,d.version]));if(signature!==this.signature){const candidate=new KnowledgeIndex(this.directory,docs);this.index=candidate;this.signature=signature;}this.until=Date.now()+5000;})().finally(()=>{this.loading=undefined;});
      await this.loading;
    }
    return this.index.search(question,role);
  }
}
