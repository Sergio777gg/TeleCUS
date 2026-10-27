import { resolve } from 'node:path';
import { parseAdditionalOrigins } from './origin-policy.js';
// Institutional destination approved for TeleCUS; never taken from chat/model input.
export const PAYMENT_PORTAL_URL='https://pagosonline.sirec.unicauca.edu.co/';
export function config() {
  const mode = process.env.DATA_MODE || 'demo';
  if (!['demo', 'supabase-readonly', 'supabase-live'].includes(mode)) throw new Error('DATA_MODE inválido.');
  const host = process.env.API_HOST || '127.0.0.1';
  if (mode === 'demo' && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('El modo de prueba solo puede escuchar en este equipo.');
  const internalToken = process.env.TELECUS_INTERNAL_TOKEN || '';
  const demoSecret = process.env.DEMO_SESSION_SECRET || '';
  if (internalToken.length < 32 || demoSecret.length < 32) throw new Error('Ejecuta la configuración inicial para generar los secretos locales.');
  return {
    mode, host, port: Number(process.env.API_PORT || 5173),
    origin: process.env.APP_ORIGIN || 'http://localhost:5173',
    additionalOrigins: parseAdditionalOrigins(process.env.APP_ALLOWED_ORIGINS),
    supabaseUrl: process.env.SUPABASE_URL || '', supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    databaseUrl: process.env.DATABASE_URL || '', databaseFile: resolve(process.env.SQLITE_FILE || 'data/telecus.sqlite'),
    paymentFilesDirectory: resolve(process.env.PAYMENT_FILES_DIRECTORY || 'data/payment-receipts'),
    clinicalFilesDirectory: resolve(process.env.CLINICAL_FILES_DIRECTORY || 'data/clinical-documents'),
    paymentFilesKey: process.env.PAYMENT_FILES_KEY || demoSecret,
    inferenceUrl: process.env.INFERENCE_URL || 'http://127.0.0.1:1880/telecus/internal/interpret',
    internalToken, demoSecret, worker: process.env.PROCESS_KIND !== 'delivery-worker' && process.env.RUN_WORKER !== 'false',
    agendaUrl: process.env.AGENDA_DATABASE_URL || '', agendaCaFile: resolve(process.env.AGENDA_CA_FILE || 'data/supabase-ca.crt'),
    agendaAddress: process.env.AGENDA_DATABASE_ADDRESS || undefined,
    deliveries: process.env.PROCESS_KIND !== 'worker' && process.env.RUN_DELIVERY_WORKER === 'true',
    model: process.env.TELECUS_AI_MODEL || 'telecus-local', modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 120000),
  };
}
