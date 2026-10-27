// A bounded test session. This script never reads the token or captures requests.
const {spawn} = require('node:child_process');
const TARGET = 'http://127.0.0.1:5173';
const AGENT = 'http://127.0.0.1:4040';
const DURATION_MS = 60 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function get(path) {
  return fetch(path, {signal: AbortSignal.timeout(3000)});
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log('Túnel de prueba: solo puerto 5173; máximo 60 minutos; inspección local deshabilitada.');
    console.log('Usa node scripts/ngrok-session.cjs. En modo real exige autorización explícita mediante --allow-live.');
    return;
  }
  const health = await get(TARGET + '/api/healthz').catch(() => null);
  if (!health?.ok) throw Error('Inicia TeleCUS antes de abrir el túnel.');
  const config = await (await get(TARGET + '/api/config')).json();
  if (!['supabase-readonly', 'supabase-live'].includes(config.mode)) throw Error('Este acceso público solo permite modos con autenticación real; no publica perfiles abiertos del modo demo.');
  if (config.mode === 'supabase-live' && !process.argv.includes('--allow-live')) {
    throw Error('TeleCUS está en modo real. Publicarlo requiere autorización explícita y el parámetro --allow-live.');
  }
  for (const route of ['/api/me', '/api/notifications', '/api/integrations/deliveries']) {
    if ((await get(TARGET + route)).status !== 401) throw Error('No se abrirá el túnel: verifica la autenticación del backend.');
  }
  if (await get(AGENT + '/api/tunnels').catch(() => null)) throw Error('Ya hay un agente en el puerto 4040. Revisa esa sesión antes de iniciar otra.');
  const child = spawn('ngrok.exe', ['http', TARGET, '--inspect=false', '--log=false'], {windowsHide:true, stdio:['ignore','ignore','pipe']});
  let ended = false, failureCode = '', launchFailed = false, timeout;
  const stop = () => {if (!ended) child.kill();};
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  const onMessage=message=>{if(message?.type==='telecus.stop')stop();};
  process.on('message',onMessage);
  process.once('disconnect',stop);
  const finished = new Promise(resolve => {
    child.once('error', () => {ended = true; launchFailed = true; resolve(-1);});
    child.once('exit', code => {ended = true; resolve(code);});
  });
  // Observe failures without recording raw logs, headers, bodies or credentials.
  child.stderr.on('data', data => {const match = data.toString().match(/ERR_NGROK_\d+/); if (match) failureCode = match[0];});
  timeout = setTimeout(stop, DURATION_MS);
  try {
    let address;
    for (let attempt = 0; attempt < 60 && !ended; attempt++) {
      const response = await get(AGENT + '/api/tunnels').catch(() => null);
      if (response?.ok) {
        const tunnels = (await response.json()).tunnels || [];
        const owned = tunnels.find(tunnel => tunnel.proto === 'https' && tunnel.config?.addr === TARGET);
        if (owned) {address = new URL(owned.public_url); if (address.protocol !== 'https:') throw Error('El túnel debe utilizar HTTPS.'); break;}
      }
      await pause(500);
    }
    if (launchFailed) throw Error('No se pudo iniciar ngrok. Comprueba su instalación.');
    if (!address) throw Error('ngrok no estableció el túnel.' + (failureCode ? ' Código: ' + failureCode : ''));
    console.log('NGROK_URL=' + address.origin);
    console.log('Sesión temporal activa durante un máximo de 60 minutos. Google y los permisos de TeleCUS siguen siendo obligatorios.');
    console.log('Aplica este origen con scripts/start-tunnel.cjs y añádelo a Redirect URLs de Supabase.');
    await finished;
    console.log('El túnel de esta sesión se cerró.');
  } finally {
    stop(); clearTimeout(timeout);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('exit', stop);
    process.removeListener('message',onMessage);process.removeListener('disconnect',stop);
    if(process.connected)process.disconnect();
    await finished.catch(() => {});
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
