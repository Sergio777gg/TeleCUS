import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { GoogleGateway } from '../google.js';
import type { GooglePort } from '../ports/integrations.js';

/** Reads the existing OAuth files privately; credentials never reach the API response. */
function loadGateway(secret:string){
  const client = JSON.parse(readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE || 'data/google-client.json', 'utf8')).web;
  const encrypted = JSON.parse(readFileSync(process.env.GOOGLE_TOKEN_FILE || 'data/google-tokens.enc', 'utf8'));
  const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), Buffer.from(encrypted.iv,'base64'));
  cipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
  const tokens = JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted.data,'base64')),cipher.final()]).toString());
  if (!client?.client_id || !client?.client_secret || !tokens.refresh_token) throw new Error('La conexión administrativa de Google está incompleta.');
  return new GoogleGateway({clientId:client.client_id,clientSecret:client.client_secret,refreshToken:tokens.refresh_token,
    calendarId:process.env.GOOGLE_CALENDAR_ID || 'citascus@gmail.com',sender:process.env.GOOGLE_SENDER || 'citascus@gmail.com'});
}
export function configuredGoogle(secret:string):GooglePort{
  loadGateway(secret);
  // Read the encrypted authorization for each delivery so reconnecting takes effect.
  return {calendar:task=>loadGateway(secret).calendar(task),sendNotification:task=>loadGateway(secret).sendNotification(task)};
}
