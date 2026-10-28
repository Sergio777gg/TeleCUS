import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Connection,UnitOfWork } from './ports/storage.js';
import type { SchedulingRepository,SessionRepository,ConversationUseCases,KnowledgePort,PreparedKnowledge } from './ports/application.js';
import { sessionKey } from './application/session-key.js';
export { sessionKey } from './application/session-key.js';
import { appointmentSummary,changeSummary,pilotTimes,serviceDate,timeLabel } from './application/appointments.js';
import { requestList,requestView } from './application/change-requests.js';
import {focusedPatientRequest,patientRequestFollowUp} from './application/request-follow-up.js';
import { ChatInput, Intent, Profile, Proposal, Reply } from './types.js';
import { changeChoices, ConversationContext, numbered, operationalQuery, personalRequestQuery, requestQuery, roleChoices, Selection } from './conversation.js';
import { calendarAnswer } from './calendar.js';
import {VISIT_TYPES,CARE_ROUTES,careRouteAnswer,careRouteReply,LEGACY_VISIT_POLICY,visitType,visitTypeQuestion,financiallyCleared} from './application/visit-policy.js';
import { clockText,operationReply,pendingDeliveryReply } from './presentation.js';
import { activeDraft,carryDialogue,dialogueGrounding,expectedSlot,recordDialogue } from './application/dialogue-state.js';
import type { ExpectedSlot } from './application/dialogue-state.js';
import { fieldRefusal,fieldKeys,refusalReply,socialReply } from './application/dialogue-policy.js';
import { stepExplanation } from './application/step-help.js';
import { declinesSupport } from './application/support-policy.js';
import { dismissEvidence,hasControlSignal,pureNegation,undecidedAnswer } from './application/language-signals.js';
import {DEFAULT_SCHEDULE_BOOK,scheduleFor,scheduleTimes,dayNames,validServiceDay,minutesOf,operatingHoursQuestion} from './application/service-schedule.js';
const allowed: Record<string,string[]> = {
  PATIENT: ['menu','change_options','list_appointments','select_appointment','availability','reserve','reschedule','cancel','payment_status','pending_requests','request_status','select_request','knowledge','confirm','deny','unknown'],
  ADMIN: ['menu','change_options','list_appointments','select_appointment','availability','pending_payments','pending_requests','request_status','select_request','verify_payment','assign_doctor','approve_change','reject_change','reschedule','cancel','knowledge','confirm','deny','unknown'],
  DOCTOR: ['menu','list_appointments','select_appointment','complete','knowledge','confirm','deny','unknown']
};
export class DomainService implements ConversationUseCases {
  constructor(public repository:SchedulingRepository,private sessions:SessionRepository,private unitOfWork:UnitOfWork,private knowledge?:KnowledgePort,private options:{directPayments?:boolean}={}) {}
  state(user:Profile,id:string,cx?:Connection){return this.sessions.load(user,id,cx);}
  async invalidateRejectedConfirmation(user:Profile,input:ChatInput,cx:Connection){
    if(input.action!=='confirm'||!input.proposalId)return;
    await this.sessions.lock(user,input.sessionId,cx);
    const state=await this.state(user,input.sessionId,cx);
    if(state.proposal?.id!==input.proposalId)return;
    delete state.proposal;
    await this.sessions.save(user,input.sessionId,state,cx);
  }
  async grounding(user:Profile,input:ChatInput) {
    const state=await this.state(user,input.sessionId);
    const book=await this.repository.schedules?.()||DEFAULT_SCHEDULE_BOOK,policy=scheduleFor(book,activeDraft(state)?.date),dialogue=dialogueGrounding(state);
    if(dialogue.expectedSlot==='date')dialogue.requestedWeekday=policy.days.length===1?policy.days[0]:null;
    return { role:user.role, today:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date()), timezone:'America/Bogota', doctors:await this.repository.doctors(user), draft:activeDraft(state), awaiting:state.awaiting||null, selection:state.selection||null, context:state.context||{menu:{type:'menu',choices:roleChoices[user.role]}}, service:{...policy,policies:book.items},dialogue,pendingConfirmation:Boolean(state.proposal) };
  }
  async prepareKnowledge(user:Profile,input:ChatInput,intent:Intent|null) {
    if(operatingHoursQuestion(input.chatInput))return undefined;
    const question=/^\d+[.!]?\s*$/.test(input.chatInput)?'Información general de TeleCUS: horario del piloto, duración y pre-reserva.':input.chatInput;
    return intent?.intent==='knowledge' && !personalRequestQuery(input.chatInput) && !operationalQuery(input.chatInput,user.role) && this.knowledge && allowed[user.role].includes('knowledge') ? (this.knowledge.answerResult?this.knowledge.answerResult(question,user.role):this.knowledge.answer(question,user.role)) : undefined;
  }
  async process(user:Profile,input:ChatInput,intent:Intent|null,connection?:Connection,preparedKnowledge?:PreparedKnowledge):Promise<Reply> {
    if(input.action==='sendMessage'&&intent&&intent.intent!=='support'&&personalRequestQuery(input.chatInput))intent={...intent,intent:'request_status'};
    if(input.action==='sendMessage'&&intent&&intent.intent!=='support'){const requests=requestQuery(input.chatInput,user.role);if(requests)intent={...intent,...requests};}
    if(input.action==='sendMessage'&&intent&&intent.intent!=='support'&&intent.dialogue_act!=='ask'){const query=operationalQuery(input.chatInput,user.role);if(query)intent={...intent,intent:query};}
    const book=await this.repository.schedules?.(connection)||DEFAULT_SCHEDULE_BOOK;
    const knowledgeAnswer=preparedKnowledge??(!connection?await this.prepareKnowledge(user,input,intent):undefined);
    const handle=async (cx:Connection):Promise<Reply>=> {
      let state=await this.state(user,input.sessionId,cx);
      const visitPolicy=await this.repository.visitPolicy?.(cx)||LEGACY_VISIT_POLICY;
      const serviceAssignment=visitPolicy.available&&user.role==='PATIENT';
      const policy=scheduleFor(book,intent?.date||activeDraft(state)?.date),pilotTimes=scheduleTimes(policy),days=dayNames(policy),hours=pilotTimes.map(timeLabel).join(', '),dateQuestion=policy.days.length===1?`¿Qué ${days} prefieres?`:`¿Qué fecha prefieres? Atendemos ${days}.`;
      const scheduleText=`Atendemos ${days}, de ${timeLabel(policy.start)} a ${timeLabel(policy.end)}, hora de Colombia, en citas de 30 minutos.`;
      const context:ConversationContext=state.context||{menu:{type:'menu',choices:roleChoices[user.role]}};
      const persist=async(next:any)=>{state={...next,context,dialogue:carryDialogue(state.dialogue,next)};await this.sessions.save(user,input.sessionId,state,cx);};
      const referencedId=(type:'requests'|'appointments',index?:number|null)=>{
        const reference=context.references;
        if(!reference||reference.type!==type||Date.now()-new Date(reference.at).getTime()>10*60000)return undefined;
        return index!=null?reference.ids[index-1]:reference.ids.length===1?reference.ids[0]:undefined;
      };
      const focusedRequest=()=>context.references?.type==='requests'&&Date.now()-new Date(context.references.at).getTime()<=10*60000&&context.references.ids.includes(context.focusedRequestId||'')?context.focusedRequestId:undefined;
      const remember=(type:'requests'|'appointments',ids:string[])=>{context.references={type,ids,at:new Date().toISOString()};};
      const requestReferenceError=()=>context.references?.type==='appointments'?'La lista actual contiene citas, no solicitudes de cambio. Escribe «Ver solicitudes de cambio pendientes» y elige una solicitud de esa lista.':'La referencia a esa lista venció o no es válida. Vuelve a consultar las solicitudes.';
      const reply=(text:string,includeProposal=true):Reply=>{
        text=clockText(text);
        const pending:Proposal|undefined=state.proposal;
        if(includeProposal&&pending&&new Date(pending.expires_at).getTime()>Date.now()){
          const {payload,...proposal}=pending;proposal.summary=clockText(proposal.summary);
          return {reply:`${text}\n\nLa operación que revisaste sigue pendiente de confirmación. Puedes usar «Confirmar» o «Descartar» cuando estés listo.`,proposal,mode:this.repository.mode};
        }
        return {reply:text,mode:this.repository.mode};
      };
      // Las rutas no agendables invalidan también una propuesta pendiente.
      const careRoute=input.action==='sendMessage'&&user.role==='PATIENT'
        ?careRouteAnswer(input.chatInput)||CARE_ROUTES.find(r=>r.code===intent?.appointment_type)?.code:undefined;
      if(careRoute){await persist({});return reply(careRouteReply(careRoute),false);}
      if(input.action==='confirm') {
        const proposal:Proposal|undefined=state.proposal;
        if(!proposal || input.proposalId!==proposal.id) throw new ConflictException('No hay una operación pendiente con esa confirmación.');
        if(proposal.kind==='reserve'&&proposal.payload.visit_policy_version&&proposal.payload.visit_policy_version!==visitPolicy.version)throw new ConflictException('La modalidad del servicio cambió. Revisa nuevamente la solicitud antes de confirmarla.');
        if(this.options.directPayments&&proposal.kind==='verify_payment'){await persist({});return {...reply('La verificación del pago se realiza en el panel administrativo. Abre Pagos, revisa el comprobante y confirma allí.',false),ui_action:'payments'};}
        if(new Date(proposal.expires_at).getTime()<Date.now()) throw new ConflictException('La confirmación venció. Solicita nuevamente la operación.');
        if(['reserve','reschedule'].includes(proposal.kind)&&proposal.payload.schedule_version&&proposal.payload.schedule_version!==book.version)throw new ConflictException('Los horarios cambiaron. Solicita nuevamente la operación para revisar la disponibilidad actual.');
        const result=await this.repository.execute(user,proposal.kind,proposal.payload,cx,proposal.id);
        context.lastOperation={kind:proposal.kind,appointment_code:proposal.payload.appointment_code,request_id:proposal.payload.request_id};
        await persist({});
        return reply(operationReply(proposal.kind,result));
      }
      if(intent?.intent==='support'&&user.role==='ADMIN')return reply('Puedes gestionar pacientes, médicos, pagos y conocimiento desde «Administración». Si una operación falla, consulta su estado antes de reintentar; conservo tu gestión.');
      if(intent?.intent==='support'){
        const repeated=Boolean(context.supportOffers);context.supportOffers=Math.min(2,(context.supportOffers||0)+1);await persist({...state});
        return {...reply(repeated?'Podemos continuar con el equipo de TeleCUS por WhatsApp. Allí pueden resolver tus dudas y ayudarte a agendar la cita. Usa «Contactar por WhatsApp»; lo que elegiste aquí se conserva.':'Entiendo. Si estás teniendo dificultades con el chat o prefieres hablar con una persona, el equipo de TeleCUS puede resolver tus dudas y ayudarte a agendar la cita. Usa «Contactar por WhatsApp». Conservo lo que llevas de tu gestión.'),handoff:{reason:'requested'}};
      }
      if(intent?.inquiry==='capability'){
        if(!allowed[user.role].includes(intent.intent))throw new ForbiddenException('Tu rol no permite esa gestión.');
        const name=intent.intent==='reschedule'?'reprogramación':'cancelación';
        return {...reply(`Sí, puedes solicitar la ${name} de una cita vigente. Primero revisaremos tu cita; si ya está confirmada, el cambio requiere aprobación administrativa. Consultarlo no modifica tu cita.`),choices:[{label:intent.intent==='reschedule'?'Buscar otro horario':'Solicitar cancelación',value:intent.intent==='reschedule'?'Reprogramar mi cita':'Cancelar mi cita'}]};
      }
      if(intent?.inquiry==='attendance')return {...reply('Podemos buscar otro horario o solicitar la cancelación. ¿Qué prefieres? Tu cita conserva su estado mientras decides.'),choices:[{label:'Buscar otro horario',value:'Reprogramar mi cita'},{label:'Solicitar cancelación',value:'Cancelar mi cita'}]};
      if(intent?.inquiry==='payment'){
        const appointments=await this.repository.appointments(user,cx),pending=appointments.find(a=>a.status==='PRE_RESERVED'&&a.payment_status==='PENDING'),free=appointments.find(a=>!['CANCELLED','COMPLETED'].includes(a.status)&&a.payment_status==='NOT_REQUIRED');
        return pending?{...reply(`Puedes gestionar el pago de ${pending.code} en el apartado de esa cita. Abre el portal institucional y adjunta allí el comprobante; el Administrador verificará el recaudo.`),ui_action:'payments'}:reply(free?'Tu solicitud vigente pertenece al piloto gratuito: no necesitas pagar ni adjuntar comprobantes.':'No tienes un pago pendiente para una cita vigente. Puedes consultar tu cita para revisar su estado.');
      }
      if((intent?.inquiry==='availability'||intent?.intent==='availability'&&!intent.date&&!intent.time&&!activeDraft(state))&&serviceAssignment&&this.repository.serviceAvailability){
        const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date());
        if(intent.date){
          const slots=await this.repository.serviceAvailability(user,intent.date,cx),selection:Selection={type:'slots',choices:slots.map(time=>({label:timeLabel(time),intent:'reserve',date:intent!.date!,time}))};
          await persist({...state,selection});return {...reply(slots.length?`Estos son los horarios disponibles para ${intent.date}. Elegir uno prepara una solicitud; aún tendrás que revisarla y confirmarla.`:'No hay cupos libres para esa fecha. Puedes consultar otro día.'),choices:slots.map(time=>({label:timeLabel(time),value:`Solicitar una cita para ${intent!.date} a las ${time}`}))};
        }
        const dates:{date:string;slots:number}[]=[];for(let offset=0;offset<14&&dates.length<5;offset++){const day=new Date(today+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+offset);const date=day.toISOString().slice(0,10);if(!validServiceDay(date,scheduleFor(book,date)))continue;const slots=await this.repository.serviceAvailability(user,date,cx);if(slots.length)dates.push({date,slots:slots.length});}
        const label=(date:string)=>new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',weekday:'long',day:'numeric',month:'long'}).format(new Date(date+'T12:00:00-05:00'));
        await persist({...state,selection:{type:'dates',choices:dates.map(d=>({label:label(d.date),intent:'availability',inquiry:'availability',date:d.date}))}});
        return {...reply(dates.length?'Estos días tienen cupos disponibles. Elige un día para ver sus horas. Consultar no crea una reserva.':'No encontré cupos en los próximos 14 días. Puedes indicar otra fecha o contactar al equipo de TeleCUS.'),choices:dates.map(d=>({label:label(d.date),value:'Ver horarios para '+d.date}))};
      }
      if(this.options.directPayments&&user.role==='ADMIN'&&intent?.intent==='verify_payment')return {...reply('Puedes verificar el pago directamente en el panel: revisa el comprobante, contrasta el recaudo y confirma la operación.'),ui_action:'payments'};
      if(intent?.dialogue_act==='ask'){
        const slot=expectedSlot(state),reminder=slot==='time'?'¿Cuál prefieres para tu cita? Escribe la hora para elegirla.':slot==='reason'?'Seguimos en el motivo general de la cita; aún no he cambiado ese dato.':slot==='date'?dateQuestion+' Puedes escribir «19 de octubre de 2026», «diecinueve de octubre» o DD/MM/AAAA'+(policy.days.length===1?' o «el siguiente».':'.'):'Conservo los datos de tu gestión.';
        if(intent.intent==='availability'&&intent.reference_time){
          if(!allowed[user.role].includes('availability'))throw new ForbiddenException('Tu rol no permite esa operación.');
          const time=intent.reference_time,draft=activeDraft(state),doctor=(await this.repository.doctors(user,cx)).find(d=>d.id===draft?.doctor_id||d.full_name===draft?.doctor_name);
          const options=`Los turnos comienzan a las ${hours}, hora de Colombia.`;
          if(!pilotTimes.includes(time))return reply(`Ese inicio no corresponde a un turno de 30 minutos del piloto. ${options}\n\n${reminder}`);
          if(!draft?.date||!doctor&&!serviceAssignment)return reply(`${timeLabel(time)} sí corresponde a un turno del piloto. Para comprobar si está libre necesito ${!draft?.date?'el '+(policy.days.length===1?days:'día')+' que prefieres':'el médico'}. No he seleccionado esa hora.\n\n${reminder}`);
          const free=serviceAssignment&&this.repository.serviceAvailability?await this.repository.serviceAvailability(user,draft.date,cx):await this.repository.availability(user,doctor!.id,draft.date,cx);
          return reply(`${timeLabel(time)} ${free.includes(time)?'aparece disponible':'no aparece disponible'} ${serviceAssignment?'en TeleCUS':'para '+doctor!.full_name} el ${draft.date}, según la agenda actual. No he seleccionado esa hora; la disponibilidad se vuelve a comprobar al confirmar.\n\n${reminder}`);
        }
        if(intent.dialogue_target==='time'&&intent.reference_time)return reply(`Ese horario equivale a ${timeLabel(intent.reference_time)} en formato de 12 horas. Los turnos del servicio son ${hours}.\n\n${reminder}`);
        const target=intent.dialogue_target==='task'&&slot==='confirmation'?'confirmation':intent.dialogue_target;
        if(target&&target!=='task'){
          const next=state.selection?`Para continuar, elige por número o nombre:\n${numbered(state.selection.choices)}`:slot==='confirmation'?'Revisa los datos de la operación que aparece pendiente.':state.prompt?.text||reminder;
          return reply(`${(target==='doctor'&&serviceAssignment?'TeleCUS asigna un médico disponible; no necesitas elegirlo. El Administrador puede revisar la asignación antes de confirmar la cita.':target==='option'&&state.selection?.type==='appointment_types'?'El tipo de atención ayuda a preparar tu solicitud y los documentos previos. Elegirlo no certifica que la atención pueda hacerse por teleconsulta; eso debe revisarlo el personal autorizado.':stepExplanation(target))}\n\n${next}`);
        }
        return reply(`Dime qué dato u opción quieres que te explique. Una pregunta no selecciona ni confirma un horario. ${reminder}`);
      }
      if(input.action==='sendMessage'&&intent&&fieldRefusal(intent)){
        const field=intent.dialogue_target!,draft=activeDraft(state),repeated=state.refusedField===field;
        if(!draft)return reply('Entiendo. No hace falta compartir ese dato aquí. Puedes pedir el menú o consultar con el personal administrativo.');
        const next={...draft};for(const key of fieldKeys[field]||[])delete next[key];
        if(field==='appointment')delete context.focusedAppointmentCode;
        if(field==='request')delete context.focusedRequestId;
        const text=refusalReply(field,repeated);
        await persist({draft:next,awaiting:field,refusedField:field,prompt:{slot:field,text}});
        return reply(text,false);
      }
      if(input.action==='dismiss' || intent?.intent==='deny'&&dismissEvidence(input.chatInput,expectedSlot(state)==='confirmation')) { await persist({}); return reply('De acuerdo. No se realizó ningún cambio.'); }
      if(intent?.intent==='deny')intent={...intent,intent:'unknown',dialogue_act:'clarify'};
      if(input.action==='roleOverview') intent={intent:'menu',appointment_code:null,doctor_name:null,date:null,time:null,reason:null,request_id:null};
      if(!intent || (intent.intent!=='greeting'&&!allowed[user.role].includes(intent.intent))) throw new ForbiddenException('Tu rol no permite esa operación.');
      if(intent.intent==='greeting')return reply(socialReply(Boolean(activeDraft(state)),Boolean(state.dialogue?.recentTurns?.length),intent.dialogue_act==='social'));
      if(state.refusedField){
        const supplied=Object.fromEntries((fieldKeys[state.refusedField]||[]).filter(key=>typeof (intent as any)[key]==='string'&&(intent as any)[key].trim()).map(key=>[key,(intent as any)[key]]));
        if(Object.keys(supplied).length)await persist({...state,draft:{...state.draft,...supplied},refusedField:undefined,awaiting:undefined});
        else if(intent.reset_slot||intent.dialogue_act==='correct')await persist({...state,refusedField:undefined});
        else if(intent.dialogue_act!=='new_task'&&(intent.intent===state.draft?.intent||intent.intent==='confirm'))return reply(refusalReply(state.refusedField,true),false);
      }
      // A cancellation/reschedule in the request review context means approving that request.
      // Bind only a matching pending record; the button remains the sole authorization to write.
      if(user.role==='ADMIN'&&['cancel','reschedule'].includes(intent.intent)&&context.references?.type==='requests'&&Date.now()-new Date(context.references.at).getTime()<=10*60000){
        const pending=(await this.repository.changeDetails(user,cx)).filter(c=>c.status==='PENDING'&&c.request_type===(intent!.intent==='cancel'?'CANCEL':'RESCHEDULE')&&context.references!.ids.includes(c.id)&&(!intent!.appointment_code||c.appointment_code===intent!.appointment_code));
        const focused=pending.find(c=>c.id===focusedRequest());
        if(pending.length===1||focused)intent={...intent,intent:'approve_change',request_id:(focused||pending[0]).id};
        else if(pending.length>1){
          remember('requests',pending.map(c=>c.id));context.focusedRequestId=undefined;
          await persist({draft:{intent:'approve_change'},selection:{type:'requests',choices:pending.map(c=>({label:`${c.appointment_code} · ${c.request_type==='CANCEL'?'Cancelación':'Reprogramación'}`,intent:'approve_change',request_id:c.id}))}});
          return reply('Hay varias solicitudes de ese tipo. ¿Cuál quieres aprobar?\n'+numbered(state.selection.choices)+'\n\nElige su número; después revisarás la operación antes de confirmarla.');
        }
      }
      if(intent.intent==='confirm') {
        if(!state.proposal)return reply('No hay una operación pendiente. Indica qué necesitas gestionar.');
        if(new Date(state.proposal.expires_at).getTime()<Date.now()){await persist({});return reply('La confirmación venció. Solicita nuevamente la operación para revisar sus datos actuales.');}
        const {payload,...proposal}=state.proposal;
        return {...reply(`Revisa la operación y utiliza el botón Confirmar para aplicarla.\n${proposal.summary}`,false),proposal};
      }
      // The model cannot authorize a write: only the explicit confirmation action can.
      const previousDraft=intent.dialogue_act==='new_task'?undefined:['answer','correct'].includes(intent.dialogue_act||'')?activeDraft(state):state.draft;
      const dateWeekday=policy.days.length===1?policy.days[0]:null;
      const reading=['knowledge','list_appointments','select_appointment','payment_status','pending_payments','pending_requests','request_status','select_request','unknown'].includes(intent.intent);
      if(intent.navigation==='main_menu'){delete state.draft;delete state.selection;}
      if(state.proposal&&(!reading||intent.navigation==='main_menu')){delete state.proposal;await persist(state);}
      if(intent.intent==='menu') {
        const selection:Selection={type:'menu',choices:roleChoices[user.role]};
        context.menu=selection;
        await persist({selection});
        return reply(`Puedo ayudarte con:\n${numbered(selection.choices)}\n\nEscribe el número o lo que necesitas gestionar.`);
      }
      if(intent.intent==='change_options') {
        const selection:Selection={type:'change',choices:changeChoices};
        await persist({selection});
        return reply(`¿Qué cambio necesitas?\n${numbered(selection.choices)}\n\nEscribe el número o la operación.`);
      }
      if(intent.intent==='knowledge'&&knowledgeAnswer&&typeof knowledgeAnswer!=='string')return {...reply(knowledgeAnswer.text),...(!knowledgeAnswer.resolved&&user.role!=='ADMIN'?{handoff:{reason:'unresolved' as const}}:{})};
      if(intent.intent==='knowledge'&&operatingHoursQuestion(input.chatInput))return reply(scheduleText);
      if(intent.intent==='knowledge') return reply((typeof knowledgeAnswer==='string'?knowledgeAnswer:undefined)||`TeleCUS gestiona teleconsultas de medicina general. ${scheduleText} Una pre-reserva queda pendiente de pago y de verificación administrativa.`);
      if(['list_appointments','select_appointment','payment_status','pending_payments'].includes(intent.intent)) {
        const currentView=user.role==='PATIENT'&&intent.appointment_view!=='all'&&intent.appointment_view!=='history'&&(visitPolicy.available||intent.appointment_view==='current');
        let appointments=currentView&&this.repository.portalAppointments?await this.repository.portalAppointments(user,intent.appointment_code||undefined,cx):await this.repository.appointments(user,cx);
        if(user.role==='PATIENT'&&!intent.appointment_code){if(currentView)appointments=appointments.filter(a=>!['CANCELLED','COMPLETED'].includes(a.status));if(intent.appointment_view==='history')appointments=appointments.filter(a=>['CANCELLED','COMPLETED'].includes(a.status));}
        appointments.sort((a,b)=>Number(['CANCELLED','COMPLETED'].includes(a.status))-Number(['CANCELLED','COMPLETED'].includes(b.status))||(new Date(b.start_time).getTime()-new Date(a.start_time).getTime()));
        if(intent.intent==='pending_payments') appointments=appointments.filter(a=>a.payment_status==='PENDING' && !['CANCELLED','COMPLETED'].includes(a.status));
        const target=intent.appointment_code||(intent.intent==='select_appointment'?referencedId('appointments',intent.reference_index):undefined);
        if(target) appointments=appointments.filter(a=>a.code===target);
        if(intent.intent==='select_appointment'&&!target)return reply('Selecciona una cita de la lista actual por su número o código.');
        const doctors=await this.repository.doctors(user,cx);
        const deliveries=intent.intent==='pending_payments'?await this.repository.pendingDeliveries(user):[];
        if(state.proposal&&deliveries.some(d=>d.code===state.proposal.payload.appointment_code))delete state.proposal;
        appointments=appointments.slice(0,20);
        remember('appointments',appointments.map(a=>a.code));
        context.focusedAppointmentCode=appointments.length===1?appointments[0].code:undefined;
        await persist({...state,selection:{type:'appointments',choices:appointments.map(a=>({label:a.code,intent:'select_appointment',appointment_code:a.code}))}});
        let text=appointments.length?`${intent.intent==='pending_payments'?'Estos pagos aún figuran pendientes. En cada cita se indica si la verificación ya está registrada; en ese caso, espera la sincronización y no la confirmes de nuevo.':'Este es el estado actual de las citas que puedes consultar:'}\n\n`+appointments.slice(0,20).map((a,i)=>`${i+1}. ${appointmentSummary(a,doctors)}${deliveries.find(d=>d.code===a.code)?'\n'+pendingDeliveryReply(deliveries.find(d=>d.code===a.code)!):''}`).join('\n\n'):intent.intent==='pending_payments'?'Por ahora no hay pagos pendientes de verificación.':'No se encontraron citas dentro de tu acceso.';
        if(user.role==='PATIENT'&&currentView)text=appointments.length?text.replace('Este es el estado actual de las citas que puedes consultar:','Tu cita vigente:')+'\n\nPuedes pedir «Ver historial de citas» para consultar las anteriores.':'No tienes una cita vigente. Puedes solicitar una nueva o consultar «Ver historial de citas».';
        if(user.role==='PATIENT'&&appointments.length){const changes=await this.repository.changeDetails(user,cx,true);const latest=changes.filter(c=>appointments.some(a=>a.code===c.appointment_code)).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0];if(latest)text+='\n\nÚltima solicitud de cambio de esta cita:\n'+changeSummary(latest,false);}
        return reply(text);
      }
      if(['pending_requests','request_status','select_request'].includes(intent.intent)) {
        const patientDetail=user.role==='PATIENT'&&(intent.intent==='select_request'||Boolean(intent.request_id)||intent.reference_index!=null||intent.intent==='request_status'&&!intent.request_view);
        const target=intent.request_id||(intent.reference_index!=null?referencedId('requests',intent.reference_index):intent.intent==='select_request'?referencedId('requests'):!patientDetail&&intent.intent==='request_status'&&!intent.request_view?focusedRequest():undefined);
        if(intent.reference_index!=null&&!target)return reply(requestReferenceError());
        const lastCode=intent.intent==='request_status'&&!intent.request_view?context.lastOperation?.appointment_code:undefined;
        const targeted=Boolean(target||intent.appointment_code||lastCode);
        let changes=await this.repository.changeDetails(user,cx,requestView(intent,user.role,targeted)!=='pending');
        if(patientDetail){
          const current=this.repository.portalAppointments?await this.repository.portalAppointments(user,undefined,cx):(await this.repository.appointments(user,cx)).filter(a=>!['CANCELLED','COMPLETED'].includes(a.status));
          const candidates=changes.filter(c=>(!intent!.request_type||c.request_type===intent!.request_type)&&(!intent!.request_state||c.status===intent!.request_state));
          const focus=focusedPatientRequest(candidates,current,{id:target,code:intent.appointment_code||(target?undefined:lastCode)});
          if(focus){
            const appointment=(this.repository.portalAppointments&&focus.appointment_code?await this.repository.portalAppointments(user,focus.appointment_code,cx):await this.repository.appointments(user,cx,[focus.appointment_id])).find(a=>a.id===focus.appointment_id);
            const deliveries=appointment&&!['CANCELLED','COMPLETED'].includes(appointment.status)?await this.repository.pendingDeliveries(user):[];
            const follow=patientRequestFollowUp(focus,appointment,changes,current,deliveries);
            const choices=state.proposal&&Date.parse(state.proposal.expires_at)>Date.now()?follow.choices.filter(c=>['select_appointment','list_appointments','select_request'].includes(c.intent)):follow.choices;
            remember('requests',[focus.id]);context.focusedRequestId=focus.id;context.focusedAppointmentCode=appointment?.code;
            await persist({...state,selection:{type:'next_steps',choices}});
            return {...reply(follow.text),choices:choices.map(c=>({label:c.label,value:c.request_id?'Consultar solicitud '+c.request_id:c.label}))};
          }
        }
        if(target)changes=changes.filter(c=>c.id===target);
        else if(intent.appointment_code)changes=changes.filter(c=>c.appointment_code===intent!.appointment_code);
        else if(lastCode)changes=changes.filter(c=>c.appointment_code===lastCode);
        const list=requestList(changes,intent,user.role,targeted);
        changes=list.shown;
        remember('requests',changes.map(c=>c.id));
        context.focusedRequestId=changes.length===1?changes[0].id:undefined;
        await persist({...state,selection:{type:'requests',choices:changes.map(c=>({label:`${c.request_type==='RESCHEDULE'?'Reprogramación':'Cancelación'} · ${c.appointment_code||c.id}`,intent:'select_request',request_id:c.id}))}});
        return reply(list.text);
      }
      if(intent.intent==='unknown'){
        if(state.draft&&undecidedAnswer(input.chatInput))return reply('Está bien, no tienes que decidir ahora. Conservo los datos que ya elegiste. Cuando quieras continuar, puedes indicar el dato pendiente, pedir que te explique el paso o descartar esta gestión.');
        if(intent.dialogue_target==='task'&&(hasControlSignal(input.chatInput)||pureNegation(input.chatInput)))return reply('¿Quieres descartar la gestión que estamos preparando o continuar con ella? No guardaré ese mensaje como motivo. Puedes escribir «descarta la gestión» o utilizar «Descartar» si hay una operación pendiente.');
        if(state.refusedField)return reply(refusalReply(state.refusedField,true));
        if(intent.dialogue_act==='clarify'){
          const expected=dialogueGrounding(state).expectedSlot;
          if(expected==='reason')return reply('No tengo claro si estás indicando el motivo o pidiendo otra gestión. ¿Quieres continuar con la cita, hacer una pregunta o descartar lo que estamos preparando? Conservo los datos que ya elegiste.');
          if(intent.option_number!=null)return reply(`¿Te refieres a la opción ${intent.option_number} del menú principal o al número ${intent.option_number} de la lista actual? Indica el nombre de la opción o de la lista.`);
          if(expected==='date')return reply(`Para elegir el día correcto, dime la fecha completa${policy.days.length===1?' o escribe «el próximo»':''}. Atendemos ${days}. Conservo los demás datos de tu gestión.`);
          if(expected==='time')return reply(`¿Qué hora exacta prefieres: ${hours}? Conservo el médico y la fecha.`);
        }
        if(/\?|¿|\b(?:que|como|quien|donde)\b/i.test(input.chatInput))return reply('Mi función aquí es ayudarte con el agendamiento de TeleCUS. Para otras consultas necesitarás otro asistente. '+(state.awaiting==='reason'?'Cuando quieras continuar, cuéntame el motivo general de la cita.':state.draft?'Conservo los datos que ya elegiste. Puedes continuar la gestión o pedir el menú.':'Puedes consultar tu cita, gestionar un cambio o pedir el menú de opciones.'));
        if(intent.option_number!=null)return reply(`¿Te refieres a la opción ${intent.option_number} del menú principal o al número ${intent.option_number} de la lista actual? Indica el nombre de la opción o escribe «opción ${intent.option_number} del menú».`);
        if(state.selection)return reply(`Elige una de estas opciones por número o nombre:\n${numbered(state.selection.choices)}`);
        if(state.draft){
          const d=state.draft;
          return reply(state.awaiting==='reason'?'Solo falta el motivo general de tu cita. Puedes escribirlo directamente, por ejemplo «consulta de seguimiento», sin detalles clínicos.':!d.date&&['reserve','availability','reschedule'].includes(d.intent)?`Conservo lo que ya elegiste. Me falta la fecha. ${dateQuestion} Escribe día, mes y año.`:!d.time&&['reserve','reschedule'].includes(d.intent)?`Conservo la fecha elegida. Me falta la hora: ${hours}.`:'Conservo la gestión en curso. Aclara lo que quieres completar o pide el menú para empezar otra gestión.');
        }
        return reply('Puedo ayudarte con citas, disponibilidad, pagos y solicitudes de cambio. Indica qué necesitas gestionar.');
      }
      const merging=previousDraft?.intent===intent.intent;
      const draft:any={...(merging?previousDraft:{}),...Object.fromEntries(['intent','appointment_code','doctor_name','date','time','reason','request_id','appointment_type'].filter(k=>(intent as any)[k]!=null&&(intent as any)[k]!=='').map(k=>[k,(intent as any)[k]]))};
      if(intent.reset_slot==='time')delete draft.time;
      if(intent.reset_slot==='date')delete draft.date;
      if(intent.reset_slot==='doctor'){delete draft.doctor_id;delete draft.doctor_name;}
      if(intent.date_expression&&!calendarAnswer(intent.date_expression,new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date()),dateWeekday))delete draft.date;
      if(draft.intent==='reserve') {
        const appointments=await this.repository.appointments(user,cx);
        const active=appointments.find(a=>!['CANCELLED','COMPLETED'].includes(a.status) && (this.repository.mode!=='demo' || new Date(a.end_time).getTime()>Date.now()));
        if(active){
          if(new Date(active.end_time).getTime()<=Date.now())return reply(`Tu cita ${active.code} ya pasó, pero sigue registrada sin finalizar. La agenda impide una nueva reserva mientras esté abierta. El personal administrativo debe revisarla y, si fue atendida, el médico debe finalizarla. Puedes consultar disponibilidad mientras tanto.`);
          return reply('Ya tienes una cita vigente, así que primero debemos gestionar esa cita.\n\n'+appointmentSummary(active,await this.repository.doctors(user,cx))+'\n\nPuedes escribir «Ver mi cita», «Reprogramar mi cita» o «Cancelar mi cita».');
        }
      }
      const saveDraft=async (text:string,selection?:Selection,awaiting?:ExpectedSlot)=>{
        if(draft.intent==='reserve'&&visitType(draft.appointment_type)&&draft.appointment_type!==previousDraft?.appointment_type)text=visitType(draft.appointment_type)!.notice+'\n\n'+text;
        const next={draft,...(selection?{selection}:{}),...(awaiting?{awaiting}:{})};
        const slot=awaiting||expectedSlot(next);
        await persist({...next,awaiting:slot,prompt:{slot,text}});return reply(text);
      };
      if(draft.intent==='reserve'&&visitPolicy.available&&!VISIT_TYPES.some(t=>t.code===draft.appointment_type)){
        const selection:Selection={type:'appointment_types',choices:[...VISIT_TYPES,...CARE_ROUTES].map(t=>({label:t.label,intent:'reserve',appointment_type:t.code}))};
        const result=await saveDraft(visitTypeQuestion,selection,'option');return {...result,choices:[...VISIT_TYPES,...CARE_ROUTES].map(t=>({label:t.label,value:'Tipo de cita: '+t.code}))};
      }
      if(serviceAssignment&&['reserve','availability'].includes(draft.intent)){
        delete draft.doctor_id;delete draft.doctor_name;draft.allocation='AUTO';
      }
      let appointment:any,change:any;
      // Bind references to fresh, role-scoped records before asking for slots or proposing a write.
      if(!['reserve','availability','approve_change','reject_change'].includes(draft.intent)){
        const appointments=(await this.repository.appointments(user,cx)).filter(a=>!['CANCELLED','COMPLETED'].includes(a.status));
        let code=draft.appointment_code;
        if(!code&&intent.reference_index!=null){code=referencedId('appointments',intent.reference_index);if(!code)return saveDraft('La referencia a esa lista venció o no es válida. Vuelve a consultar las citas.');}
        if(!code&&context.focusedAppointmentCode&&appointments.some(a=>a.code===context.focusedAppointmentCode))code=context.focusedAppointmentCode;
        if(!code&&appointments.length===1)code=appointments[0].code;
        if(!code){
          const selection:Selection={type:'appointments',choices:appointments.slice(0,20).map(a=>({label:a.code,intent:draft.intent,appointment_code:a.code}))};
          remember('appointments',selection.choices.map(c=>c.appointment_code!));
          return saveDraft(appointments.length?`¿Qué cita quieres gestionar?\n${appointments.slice(0,20).map((a,i)=>`${i+1}. ${appointmentSummary(a)}`).join('\n\n')}\n\nElige su número o código.`:'No hay citas que admitan esta operación dentro de tu acceso.',selection);
        }
        appointment=appointments.find(a=>a.code===code);
        if(!appointment)throw new ForbiddenException('No se encontró una cita que admita cambios dentro de tu acceso.');
        draft.appointment_code=appointment.code;context.focusedAppointmentCode=appointment.code;
      }
      if(['approve_change','reject_change'].includes(draft.intent)){
        const changes=await this.repository.changeDetails(user,cx,true);
        const pending=changes.filter(c=>c.status==='PENDING');
        let id=draft.request_id;
        const candidates=draft.appointment_code?pending.filter(c=>c.appointment_code===draft.appointment_code):pending;
        if(!id&&intent.reference_index!=null&&context.references?.type==='requests'){id=referencedId('requests',intent.reference_index);if(!id)return saveDraft(requestReferenceError());}
        if(!id&&draft.appointment_code&&candidates.length===1)id=candidates[0].id;
        if(!id&&draft.appointment_code&&!candidates.length)return saveDraft('No hay solicitudes pendientes para esa cita dentro de tu acceso. Puedes consultar el historial de solicitudes.');
        if(!id&&intent.reference_index!=null){id=referencedId('requests',intent.reference_index);if(!id)return saveDraft(requestReferenceError());}
        if(!id&&!draft.appointment_code)id=referencedId('requests')||focusedRequest();
        if(!id&&!context.references&&pending.length===1)id=pending[0].id;
        if(!id){
          const options=candidates.slice(0,20);
          remember('requests',options.map(c=>c.id));context.focusedRequestId=undefined;
          const selection:Selection={type:'requests',choices:options.map(c=>({label:`${c.request_type==='RESCHEDULE'?'Reprogramación':'Cancelación'} · ${c.appointment_code||c.id}`,intent:draft.intent,request_id:c.id}))};
          return saveDraft(options.length?`${options.length===1?'Esta solicitud está pendiente de revisión.':'Hay varias solicitudes. ¿Cuál quieres revisar?'}\n${options.map((c,i)=>`${i+1}. ${changeSummary(c,true,user.role)}`).join('\n\n')}\n\nElige su número o referencia.`:'No hay solicitudes pendientes dentro de tu acceso.',selection);
        }
        change=changes.find(c=>c.id===id);
        if(!change)throw new ForbiddenException('No se encontró esa solicitud dentro de tu acceso.');
        if(change.status!=='PENDING'){await persist({});return reply(`Esa solicitud ya fue revisada y no admite otra aprobación o rechazo.\n${changeSummary(change,true,user.role)}`);}
        if(draft.appointment_code&&change.appointment_code!==draft.appointment_code)return saveDraft('El número y el código corresponden a gestiones distintas. Consulta nuevamente las solicitudes y elige una sola.');
        if(!change.appointment_code)return saveDraft('No se pudo consultar la cita de esa solicitud. Actualiza la lista antes de continuar.');
        draft.request_id=change.id;draft.appointment_code=change.appointment_code;context.focusedRequestId=change.id;
      }
      if(draft.appointment_code&&user.role==='ADMIN'){
        const pending=(await this.repository.pendingDeliveries(user)).find(d=>d.code===draft.appointment_code);
        if(pending){await persist({});return reply(pendingDeliveryReply(pending),false);}
      }
      if(['reserve','availability','reschedule'].includes(draft.intent)&&draft.time&&!pilotTimes.includes(draft.time)){
        const outside=minutesOf(draft.time)<minutesOf(policy.start)||minutesOf(draft.time)>=minutesOf(policy.end);
        delete draft.time;
        return saveDraft((outside?'Ese horario está fuera de la jornada del piloto.':'Ese inicio no corresponde a un turno de 30 minutos del piloto.')+` Las citas empiezan ${days} a las ${hours}, hora de Colombia. ¿Cuál de esas horas prefieres?`,merging&&state.selection?.type==='doctor'?state.selection:undefined,'time');
      }
      const doctors=await this.repository.doctors(user,cx);
      if(appointment&&draft.intent!=='assign_doctor'){
        draft.doctor_id=appointment.doctor_id;draft.doctor_name=doctors.find(d=>d.id===appointment.doctor_id)?.full_name;
      }
      if(['reserve','availability','assign_doctor'].includes(draft.intent)&&!(serviceAssignment&&['reserve','availability'].includes(draft.intent))) {
        const name=String(draft.doctor_name||'').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
        const matches=doctors.filter(d=> name && String(d.full_name).toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(name.replace(/^(dra?\.?|doctor[ae]?)\s+/i,'')));
        const doctor=matches.length===1?matches[0]:null;
        if(!doctor) {
          if(!doctors.length)return saveDraft('No hay médicos disponibles para elegir en este momento. Consulta con el personal administrativo.');
          const selection:Selection={type:'doctor',choices:doctors.map(d=>({label:d.full_name,doctor_name:d.full_name,intent:draft.intent}))};
          return saveDraft(`Elige un médico por su número o nombre:\n${numbered(selection.choices)}`,selection,'doctor');
        }
        draft.doctor_id=doctor.id;
        draft.doctor_name=doctor.full_name;
      }
      if(['reserve','availability','reschedule'].includes(draft.intent) && !draft.date) return saveDraft(`${draft.time?'Tengo la hora: '+timeLabel(draft.time)+' Me falta la fecha. ':''}${intent.date_expression?'No pude determinar una fecha segura a partir de esa expresión. ':''}${dateQuestion} Puedes escribir «19 de octubre de 2026», «diecinueve de octubre» o DD/MM/AAAA${policy.days.length===1?' o «el próximo '+days+'»':''}. También puedes indicar fecha y hora juntas. ${scheduleText}${book.items.some(p=>p.effective_from>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date()))?' Hay un cambio de horario programado; validaremos la jornada vigente para la fecha que elijas.':''}`,undefined,'date');
      if(draft.intent==='availability') {
        const day=new Date(draft.date+'T12:00:00-05:00');
        if(!validServiceDay(draft.date,policy)){
          delete draft.date;
          return saveDraft(`${policy.days.length===1?'Esa fecha no es un '+days+' válido.':'Esa fecha no corresponde a un día de atención válido.'} ${scheduleText} Escribe una fecha como «19 de octubre de 2026» o DD/MM/AAAA.`);
        }
        const slots=serviceAssignment&&this.repository.serviceAvailability?await this.repository.serviceAvailability(user,draft.date,cx):await this.repository.availability(user,draft.doctor_id,draft.date,cx);
        await persist({draft,selection:{type:'slots',choices:slots.map(time=>({label:timeLabel(time),intent:'reserve',date:draft.date,time,...(!serviceAssignment?{doctor_name:draft.doctor_name}:{})}))}});
        if(draft.time)return reply(slots.includes(draft.time)?`El ${draft.date} a las ${timeLabel(draft.time)} está disponible ${serviceAssignment?'en TeleCUS':'con '+draft.doctor_name}. Consultar disponibilidad no crea una reserva.`:`El ${draft.date} a las ${timeLabel(draft.time)} no está disponible.${slots.length?' Horarios libres: '+slots.map(timeLabel).join(', ')+'.':' No hay horarios libres ese día dentro de la jornada del piloto.'}`);
        return {...reply(slots.length?`Horarios libres para ${draft.date}:\n${slots.map((s,i)=>`${i+1}. ${timeLabel(s)}`).join('\n')}`:'No hay horarios disponibles para ese médico y día dentro de la jornada del piloto.'),...(serviceAssignment?{choices:slots.map(time=>({label:timeLabel(time),value:`Solicitar una cita para ${draft.date} a las ${time}`}))}:{})};
      }
      if(['reserve','reschedule'].includes(draft.intent)) {
        if(!draft.time) return saveDraft(`¿A qué hora? Puedes solicitar ${hours}, según disponibilidad.`,undefined,'time');
        serviceDate(draft.date,draft.time,policy);
      }
      if(draft.intent==='reserve') {
        const slots=serviceAssignment&&this.repository.serviceAvailability?await this.repository.serviceAvailability(user,draft.date,cx):await this.repository.availability(user,draft.doctor_id,draft.date,cx);
        if(!slots.includes(draft.time))return reply('Ese horario está ocupado. Consulta los horarios disponibles de TeleCUS.');
        if(!draft.reason)return saveDraft((serviceAssignment?'Ya tenemos el tipo de atención, la fecha y la hora. TeleCUS asignará al profesional.':'Perfecto, ya tenemos médico, fecha y hora.')+' ¿Cuál es el motivo general de tu cita? Escríbelo brevemente, sin detalles clínicos.',undefined,'reason');
      }
      if(this.repository.mode==='supabase-readonly') return reply('La conexión actual permite consultas. Las operaciones reales están pendientes de pruebas de integración.');
      const operationNames:Record<string,string>={reserve:'Crear pre-reserva',reschedule:'Reprogramar cita',cancel:'Cancelar cita',verify_payment:'Verificar pago y confirmar cita',assign_doctor:'Asignar médico',approve_change:'Aprobar solicitud',reject_change:'Rechazar solicitud',complete:'Marcar cita finalizada'};
      const approvalRequired=user.role==='PATIENT'&&appointment&&financiallyCleared(appointment)&&['cancel','reschedule'].includes(draft.intent);
      const operationName=approvalRequired?(draft.intent==='reschedule'?'Solicitar reprogramación':'Solicitar cancelación'):operationNames[draft.intent]||draft.intent;
      const appointmentWhen=appointment?new Intl.DateTimeFormat('es-CO',{dateStyle:'full',timeStyle:'short',hour12:true,timeZone:'America/Bogota'}).format(new Date(appointment.start_time)):null;
      const summary=change?`${operationName}\n${changeSummary(change,user.role==='ADMIN',user.role)}`:`${operationName}${draft.appointment_type?'\nTipo de atención: '+visitType(draft.appointment_type)?.label:''}${draft.appointment_code?'\nCita: '+draft.appointment_code:''}${draft.doctor_name?'\nMédico: '+draft.doctor_name:''}${draft.date?'\nFecha: '+new Intl.DateTimeFormat('es-CO',{dateStyle:'full',timeZone:'America/Bogota'}).format(new Date(draft.date+'T12:00:00-05:00')):appointmentWhen?'\nHorario actual: '+appointmentWhen:''}${draft.time?'\nHora: '+timeLabel(draft.time):''}${draft.intent==='reserve'?'\nMotivo: '+draft.reason:''}`;
      if(['reserve','reschedule'].includes(draft.intent))draft.schedule_version=book.version;
      if(draft.intent==='reserve'&&visitPolicy.available)draft.visit_policy_version=visitPolicy.version;
      const proposal:Proposal={id:randomUUID(),kind:draft.intent,summary,expires_at:new Date(Date.now()+10*60000).toISOString(),payload:draft};
      await persist({proposal});
      const {payload,...publicProposal}=proposal;
      const instruction=approvalRequired?'Al confirmar, enviaré tu solicitud para revisión administrativa. Tu cita conserva su estado actual hasta que se apruebe y se complete el cambio.':this.repository.mode==='demo'?'Revisa los datos. Al confirmar, aplicaré el cambio a la agenda de prueba.':draft.intent==='reserve'?'Revisa los datos. Al confirmar, crearé una pre-reserva con el pago pendiente. La cita y la videollamada se confirmarán después de la verificación administrativa. Tendrás hasta '+policy.hold_hours+' horas desde la creación, sin superar el inicio de la cita, para pagar y adjuntar el comprobante; de lo contrario, el cupo se liberará.':draft.intent==='reject_change'?'Al confirmar, registraré el rechazo de la solicitud. La cita seguirá con su horario actual.':'Revisa los datos. Al confirmar, registraré la operación para procesarla. Te avisaremos cuando el cambio se complete; hasta entonces, consulta el estado actual de tu cita.';
      const freeInstruction=draft.intent==='reserve'&&visitPolicy.available&&!visitPolicy.payments_enabled?'Esta solicitud pertenece al piloto gratuito. No debes pagar ni adjuntar comprobantes. Al confirmar, quedará pendiente de revisión administrativa; la cita y el enlace se anunciarán cuando se apruebe y complete la agenda.':null;
      const visitInstruction=draft.intent==='reserve'&&visitType(draft.appointment_type)?'\n\n'+visitType(draft.appointment_type)!.notice:'';
      const assignmentInstruction=serviceAssignment&&draft.intent==='reserve'?'\n\nTeleCUS asignará un médico disponible al registrar la solicitud. El Administrador puede revisar y cambiar esa asignación antes de confirmar la cita.':'';
      return {...reply(`${summary}\n\n${freeInstruction||instruction}${visitInstruction}${assignmentInstruction}`,false),proposal:publicProposal};
    };
    const execute=async(cx:Connection)=>{
      await this.sessions.lock(user,input.sessionId,cx);
      const result=await handle(cx);
      const state=await this.state(user,input.sessionId,cx);
      const unresolved=input.action==='sendMessage'&&intent?.intent==='unknown'&&!declinesSupport(input.chatInput)&&!['ask','refuse'].includes(intent.dialogue_act||'')?(state.context?.unresolvedCount||0)+1:0;
      state.context={...state.context,unresolvedCount:unresolved};
      if(unresolved>=2&&user.role!=='ADMIN')result.handoff={reason:'unresolved'};
      state.dialogue=recordDialogue(state,input,result,Boolean(intent?.reason));
      await this.sessions.save(user,input.sessionId,state,cx);
      return result;
    };
    return connection ? execute(connection) : this.unitOfWork.transaction(execute);
  }
}
