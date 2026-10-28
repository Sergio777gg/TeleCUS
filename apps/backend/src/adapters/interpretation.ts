import { ServiceUnavailableException } from '@nestjs/common';
import type { Grounding } from '../conversation.js';
import type { InterpretationPort } from '../ports/application.js';
import { abandonEvidence,bareControl,controlUtterance,normalizedDialogueText,pureNegation,questionEvidence,referencedTime,timeExplanationReference } from '../application/language-signals.js';
import { stepQuestion } from '../application/step-help.js';
import { timeExpression } from '../application/time-expression.js';

/** Node-RED is a replaceable transport; it never receives database or Google credentials. */
export class NodeRedInterpreter implements InterpretationPort {
  constructor(private endpoint:string,private internalToken:string,private timeoutMs:number,private transport:typeof fetch=fetch){}
  async interpret(message:string,context:Grounding):Promise<unknown>{
    const signal=AbortSignal.timeout(this.timeoutMs);
    const request=async(stage?:string)=>{
      let response:Response;
      try{response=await this.transport(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-TeleCUS-Internal':this.internalToken},body:JSON.stringify({message,context,...(stage?{stage,normalizedMessage:normalizedDialogueText(message)}:{})}),signal});}
      catch(error:any){if(signal.aborted)throw signal.reason;if(error?.name==='TimeoutError')throw error;throw new ServiceUnavailableException('El servicio de interpretación no está disponible. Conservo tu gestión; puedes reintentar.');}
      if(!response.ok)throw new ServiceUnavailableException('El asistente local no está disponible. Tu solicitud no modificó ninguna cita.');
      try{
        const result=await response.json();
        if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid model object');
        // The transport cannot promote a patient to a staff operation or confirm by text.
        if(context.role==='PATIENT'&&['verify_payment','complete','assign_doctor','approve_change','reject_change','confirm'].includes(result.intent))return candidate({dialogue_act:'clarify',dialogue_target:'task'});
        return result;
      }catch{throw new ServiceUnavailableException('El servicio de interpretación devolvió una respuesta inválida. Conservo tu gestión; puedes reintentar.');}
    };
    const slot=context.dialogue?.expectedSlot||context.awaiting;
    const candidate=(fields:Record<string,unknown>)=>({intent:'unknown',appointment_code:null,doctor_name:null,date:null,time:null,reason:null,request_id:null,date_expression:null,navigation:null,option_number:null,reference_index:null,request_view:null,request_type:null,request_state:null,dialogue_act:null,dialogue_target:null,reference_time:null,...fields});
    const explanation=timeExplanationReference(message,slot);
    if(explanation)return candidate({dialogue_act:'ask',dialogue_target:'time',reference_time:explanation});
    const step=stepQuestion(message,context);if(step)return candidate({dialogue_act:'ask',dialogue_target:step==='confirmation'?'task':step});
    if(context.draft&&bareControl(message))return candidate({intent:'deny',dialogue_act:'refuse',dialogue_target:'task'});
    if(slot&&pureNegation(message))return candidate(slot==='confirmation'?{intent:'deny',dialogue_act:'refuse',dialogue_target:'task'}:{dialogue_act:'clarify',dialogue_target:'task'});
    if(slot){
      const result=await request('field'),raw=result?.field_understanding,field=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw,value:raw.value??null}:raw;
      if(!field||!Object.hasOwn(field,'target')||!['provide','refuse','abandon','explain','question','clarify','support','other'].includes(field.act)||field.value!==null&&typeof field.value!=='string'||field.target!=null&&!['doctor','date','time','reason','appointment','request','option','task'].includes(field.target)||Object.keys(field).some(key=>!['act','value','target'].includes(key)))throw new ServiceUnavailableException('No pude comprender ese dato. Conservo tu gestión; escríbelo de otra manera.');
      if(field.act==='support')return candidate({intent:'support'});
      const target=field.target||slot;
      if(field.act==='explain'&&target==='time'&&questionEvidence(message)&&referencedTime(message))return candidate({dialogue_act:'ask',dialogue_target:'time',reference_time:referencedTime(message)});
      if(field.act==='explain'&&(target!=='task'||slot==='confirmation'))return candidate({dialogue_act:'ask',dialogue_target:target});
      if(field.act==='clarify')return slot==='date'?request():candidate({dialogue_act:'clarify',dialogue_target:target});
      if(field.act==='refuse')return candidate(controlUtterance(message)&&abandonEvidence(message)?{intent:'deny',dialogue_act:'refuse',dialogue_target:'task'}:{dialogue_act:'refuse',dialogue_target:target});
      if(field.act==='abandon')return candidate(abandonEvidence(message)?{intent:'deny',dialogue_act:'refuse',dialogue_target:'task'}:{dialogue_act:'clarify',dialogue_target:'task'});
      const question=questionEvidence(message);
      // A referenced clock value in a scheduling question is read-only, including when
      // the model incorrectly labels it as a field answer. Clock explanations ran above.
      const reference=referencedTime(message);
      if(question&&reference&&['reserve','reschedule','availability'].includes(context.draft?.intent)&&!['explain','refuse','abandon'].includes(field.act)&&['question','provide'].includes(field.act))return candidate({intent:'availability',dialogue_act:'ask',dialogue_target:'time',reference_time:reference});
      if(field.act==='provide'&&(controlUtterance(message)||controlUtterance(field.value||'')||question||pureNegation(message)))return candidate({dialogue_act:question?'ask':'clarify',dialogue_target:question?target:'task',reference_time:null});
      if(field.act==='provide'&&target==='time'&&['reserve','availability','reschedule'].includes(context.draft?.intent)){
        // Parse the original contribution, even if the model normalized or invented its
        // extracted value. Keep the current task and never turn an early hour into PM.
        const source=normalizedDialogueText(message),correction=/^(?:mejor|prefiero|cambio a|quise decir)\s+/.test(source);
        const time=timeExpression(source.replace(/^(?:mejor|prefiero|cambio a|quise decir)\s+/,''));
        if(time)return candidate({intent:context.draft.intent,time,dialogue_act:correction?'correct':'answer',dialogue_target:'time'});
      }
      if(field.act==='provide'&&typeof field.value==='string'&&message.toLocaleLowerCase('es').includes(field.value.toLocaleLowerCase('es'))){
        if(target==='reason'&&context.draft?.intent==='reserve')return candidate({intent:'reserve',reason:field.value,dialogue_act:'answer',dialogue_target:'reason'});
        if(target==='time'&&['reserve','availability','reschedule'].includes(context.draft?.intent)){
          const time=timeExpression(field.value)||timeExpression('a las '+field.value);
          if(time)return candidate({intent:context.draft.intent,time,dialogue_act:'answer',dialogue_target:'time'});
        }
      }
      if(field.act==='question'||field.act==='explain'){
        const general=await request();
        if(general.intent==='support')return candidate({intent:'support'});
        if(['menu','knowledge','list_appointments','payment_status','pending_payments','pending_requests','request_status'].includes(general.intent))return {...general,date:null,time:null,reason:null};
        if(!questionEvidence(message))return {...general,dialogue_act:general.dialogue_act==='ask'?null:general.dialogue_act,reference_time:null};
        return candidate({dialogue_act:'ask',dialogue_target:target});
      }
    }
    return request();
  }
}
