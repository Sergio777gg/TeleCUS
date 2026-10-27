import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Role } from './types.js';

import type { KnowledgePort } from './ports/application.js';
export type { KnowledgePort } from './ports/application.js';
type Chunk={id:string;title:string;file:string;version:string;roles:string[];text:string;terms:string[]};
const stop=new Set('a al algo ante como con cual cuando de del el ella en es esta este esto hay la las lo los me mi no o para por que se si su un una y'.split(' '));
// Apply the same conservative plural normalization to documents and queries.
// Retrieval remains lexical; this is not semantic search or a source of new facts.
const term=(s:string)=>s.length>5&&/[^aeiou]es$/.test(s)?s.slice(0,-2):s.length>4&&/[aeiou]s$/.test(s)?s.slice(0,-1):s;
const words=(s:string)=>s.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]+/g)?.filter(t=>t.length>2&&!stop.has(t)).map(term)||[];

/** Small local corpus: bounded BM25 retrieval, replaceable without changing the chat. */
export class KnowledgeIndex {
  chunks:Chunk[]=[];
  constructor(directory:string,overrides:{file:string;body:string;version?:string}[]=[]) {
    const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    for(const doc of manifest.documents) {
      if(!/^\d{2}_[A-Z_]+\.md$/.test(doc.file))throw new Error('Archivo de conocimiento inválido.');
      const source=readFileSync(join(directory,doc.file),'utf8');
      const metadata=source.match(/^---\r?\n([\s\S]*?)\r?\n---/);if(!metadata)throw new Error('Metadatos del RAG incompletos.');
      const audiences=metadata[1].match(/audience:\s*\[([^\]]+)\]/)?.[1].match(/"([a-z]+)"/g)?.map(v=>v.replaceAll('"',''))||[];
      const roles=audiences.filter(a=>['patient','admin','doctor'].includes(a));
      const override=overrides.find(d=>d.file===doc.file);
      const body=override?.body??source.slice(metadata[0].length).trim();
      for(const [n,section] of body.split(/(?=^# )/m).entries()) {
        if(section.length>4500)throw new Error('Fragmento de conocimiento demasiado extenso.');
        const text=section.trim();if(!text)continue;
        this.chunks.push({id:doc.file+':'+n,title:doc.title,file:doc.file,version:override?.version||manifest.version,roles,text,terms:words(text)});
      }
    }
  }
  search(query:string,role:Role) {
    const terms=[...new Set(words(query))],corpus=this.chunks.filter(c=>c.roles.includes(role.toLowerCase()));
    const avg=corpus.reduce((n,c)=>n+c.terms.length,0)/(corpus.length||1);
    return corpus.map(c=>{
      let score=0;
      for(const term of terms) {
        const tf=c.terms.filter(t=>t===term).length;if(!tf)continue;
        const df=corpus.filter(x=>x.terms.includes(term)).length;
        score+=Math.log(1+(corpus.length-df+0.5)/(df+0.5))*tf*2.2/(tf+1.2*(0.25+0.75*c.terms.length/avg));
      }
      return {...c,score};
    }).filter(c=>c.score>0.7).sort((a,b)=>b.score-a.score).slice(0,3);
  }
}

export class LocalKnowledge implements KnowledgePort {
  constructor(private index:{search(question:string,role:Role):ReturnType<KnowledgeIndex['search']>|Promise<ReturnType<KnowledgeIndex['search']>>},private endpoint:string,private token:string,private timeout=120000,private transport:typeof fetch=fetch){}
  async answer(question:string,role:Role) {return (await this.answerResult(question,role)).text;}
  async answerResult(question:string,role:Role) {
    const chunks=await this.index.search(question,role);
    if(!chunks.length)return {text:'No tengo información suficiente para resolver esa consulta. Podemos pedir ayuda al equipo de TeleCUS.',resolved:false};
    const response=await this.transport(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-TeleCUS-Internal':this.token},
      body:JSON.stringify({question:question.slice(0,4000),sources:chunks.map(c=>({id:c.id,text:c.text})),role}),signal:AbortSignal.timeout(this.timeout)});
    if(!response.ok)throw new Error('No fue posible consultar el conocimiento del servicio.');
    const result=await response.json() as any;
    const cited=chunks.filter(c=>Array.isArray(result.source_ids)&&result.source_ids.includes(c.id));
    if(typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>3500||!cited.length)
      return {text:'No puedo respaldar esa respuesta con el material disponible. Confírmala con el personal administrativo.',resolved:false};
    return {resolved:true,text:result.answer.trim()+'\n\nFuentes: '+[...new Set(cited.map(c=>c.title+' ('+c.version+')'))].join('; ')+'.'};
  }
}
