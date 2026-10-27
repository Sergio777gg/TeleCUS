function schemaErrors(value,schema){
 const errors=[];if(!value||typeof value!=='object'||Array.isArray(value))return ['not_object'];
 for(const key of schema.required)if(!(key in value))errors.push('missing:'+key);
 for(const [key,v]of Object.entries(value)){
  const rule=schema.properties[key];if(!rule){if(schema.additionalProperties===false)errors.push('extra:'+key);continue;}
  const types=Array.isArray(rule.type)?rule.type:[rule.type];const type=v===null?'null':Number.isInteger(v)?'integer':typeof v;
  if(!types.includes(type))errors.push('type:'+key);
  if(rule.enum&&!rule.enum.includes(v))errors.push('enum:'+key);
  if(v!=null&&((rule.minimum!=null&&v<rule.minimum)||(rule.maximum!=null&&v>rule.maximum)))errors.push('range:'+key);
 }
 return errors;
}
function score(value,expect,resolvedDate){
 const checks=[];const add=(key,pass)=>checks.push({key,pass:Boolean(pass)});
 if(expect.intent)add('intent',expect.intent.includes(value?.intent));
 if(expect.notIntent)add('notIntent',!expect.notIntent.includes(value?.intent));
 for(const [key,wanted]of Object.entries(expect.fields||{}))add('field:'+key,(value?.[key]??null)===wanted);
 if(expect.date)add('resolvedDate',resolvedDate===expect.date);
 if(expect.clarify)add('clarification',value?.intent==='unknown'&&value?.dialogue_act==='clarify');
 return checks;
}
function percentile(values,p){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];}
module.exports={schemaErrors,score,percentile};
