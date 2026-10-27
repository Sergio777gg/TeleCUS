const fs = require('node:fs');
const crypto = require('node:crypto');
class SetupError extends Error {}

require('./runtime-env.cjs')();

async function main() {
  const clientFile = process.env.GOOGLE_OAUTH_CLIENT_FILE || 'data/google-client.json';
  const tokenFile = process.env.GOOGLE_TOKEN_FILE || 'data/google-tokens.enc';
  if (!fs.existsSync(clientFile) || !fs.existsSync(tokenFile)) {
    throw new SetupError('Primero completa launchers/windows/CONECTAR_GOOGLE.cmd.');
  }
  if (!process.env.DEMO_SESSION_SECRET) throw new SetupError('Falta la configuración local de TeleCUS.');
  const client = JSON.parse(fs.readFileSync(clientFile, 'utf8')).web;
  const encrypted = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const key = crypto.createHash('sha256').update(process.env.DEMO_SESSION_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const tokens = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final(),
  ]).toString('utf8'));
  if (!client?.client_id || !client?.client_secret || !tokens.refresh_token) {
    throw new SetupError('La conexión de Google está incompleta.');
  }

  const refresh = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id, client_secret: client.client_secret,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!refresh.ok) throw new SetupError('Google no pudo renovar el acceso. Vuelve a conectar la cuenta.');
  const fresh = await refresh.json();
  if (!fresh.access_token) throw new SetupError('Google no devolvió acceso válido.');
  const scopes = new Set((fresh.scope || tokens.scope || '').split(/\s+/));
  const calendarPermission = scopes.has('https://www.googleapis.com/auth/calendar.events');
  const gmailPermission = scopes.has('https://www.googleapis.com/auth/gmail.send');
  if (!calendarPermission || !gmailPermission) {
    throw new SetupError('Falta autorizar eventos de Calendar o envío de Gmail.');
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'citascus@gmail.com';
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events');
  // Filter the response at Google: no appointment rows, titles or attendees are returned.
  url.search = new URLSearchParams({ maxResults: '1', fields: 'kind,accessRole,timeZone' }).toString();
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + fresh.access_token },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new SetupError('No fue posible acceder al calendario configurado (HTTP ' + response.status + ').');
  const metadata = await response.json();
  if (!['owner', 'writer'].includes(metadata.accessRole)) {
    throw new SetupError('La cuenta no tiene permiso para administrar eventos en el calendario.');
  }
  console.log(JSON.stringify({
    status: 'ok', refreshedAccess: true,
    permissions: { calendarEvents: calendarPermission, gmailSend: gmailPermission },
    calendar: { id: calendarId, accessRole: metadata.accessRole, timeZone: metadata.timeZone },
    eventsCreated: 0, emailsSent: 0,
  }, null, 2));
}

main().catch(error => {
  // Never expose response bodies, credential values or stack traces.
  console.error(error instanceof SetupError ? error.message : 'No fue posible verificar la conexión de Google. Revisa la configuración local y la conexión a Internet.');
  process.exitCode = 1;
});
