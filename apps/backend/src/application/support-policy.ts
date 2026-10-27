import { normalizeText } from '../calendar.js';

/** Respect explicit rejection of contact and reports that a technical problem has ended. */
export function declinesSupport(message:string):boolean {
  const text=normalizeText(message);
  const declined=/\bno\s+(?:quiero|necesito|deseo|me interesa)\s+(?:mas\s+)?(?:ayuda|soporte|(?:hablar|contactar|comunicarme)\b)/.test(text);
  const resolved=/\b(?:ya\s+)?no\s+(?:tengo|hay|veo|encuentro)\s+(?:mas\s+)?(?:problemas?|fallos?|errores?)\b/.test(text)&&/\b(?:chat(?:bot)?|asistente|sistema|pagina|aplicacion)\b/.test(text);
  return declined||resolved;
}

/** High-confidence dialogue controls only. Ambiguous paraphrases still use semantic interpretation. */
export function supportSignal(message:string):boolean {
  const text=normalizeText(message).replace(/[,;:]+/g,' ').replace(/\s+/g,' ');
  const positive=/\b(?:quiero|quisiera|necesito|prefiero|puedo|podria|podemos|gustaria|deseo|quier[a-z]*|ponme|comunica[a-z]*|contacta[a-z]*|pasame|hablar|contactar|atenderme)\b/.test(text);
  const person=/\b(?:human[oa]s?|persona|alguien|asesor[a]?|operador[a]?|personal administrativo|equipo de (?:telecus|soporte))\b/.test(text);
  const contact=/\b(?:hablar|contact[a-z]*|comunica[a-z]*|atend[a-z]*|atiend[a-z]*|pasame|ponme)\b/.test(text);
  const declinesContact=/\bno\s+(?:quiero|necesito|prefiero|deseo|me gustaria)\b/.test(text);
  if(positive&&person&&contact&&!declinesContact)return true;

  // A complaint about understanding the user differs from not understanding a time or refusing a field.
  if(/\bno\s+(?:me\s+)?(?:estas?\s+)?(?:entiendes|entendiendo|comprendes|comprendiendo|escuchas|escuchando)\b/.test(text))return true;
  const system=/\b(?:chat(?:bot)?|asistente|sistema|pagina|aplicacion|plataforma|respuesta|respuestas)\b/.test(text);
  const difficulty=/\b(?:problemas?|fall[a-z]*|errores?|trab[a-z]*|bloque[a-z]*)\b|\bno\s+(?:me\s+)?(?:funcionan?|ayudan?|sirven?|resuelven?|entienden?|entiendo)\b/.test(text);
  const resolved=/\b(?:ya\s+)?no\s+(?:tengo|hay|veo|encuentro)\s+(?:mas\s+)?(?:problemas?|fallos?|errores?)\b/.test(text);
  if(system&&difficulty&&!resolved)return true;

  // An unqualified request for assistance offers both self-service and a human channel.
  const bare=text.replace(/^(?:(?:por favor|porfa|hola|oye|si|pues|tambien)\s+)+/,'')
    .replace(/\s+(?:por favor|porfa)$/,'');
  return /^(?:(?:yo\s+)?(?:necesito|quiero|quisiera|requiero|pido)\s+(?:un poco de\s+)?ayuda|ayuda|ayudame|ayudeme|me ayudas|puedes ayudarme|puede ayudarme|soporte|contactar soporte|reportar (?:un )?(?:fallo|problema))$/.test(bare);
}
