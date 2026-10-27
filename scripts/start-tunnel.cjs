// The tunnel itself is created by VS Code, ngrok or another provider. This only permits its exact origin
// for the current TeleCUS process, keeping the local .env and data mode intact.
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
async function main() {
  const {parseAdditionalOrigins} = await import('../apps/backend/dist/origin-policy.js');
  const origins = parseAdditionalOrigins(process.argv[2]);
  if (origins.length !== 1) throw Error('Indica una sola dirección HTTPS: node scripts/start-tunnel.cjs https://DIRECCION-DEL-TUNEL');
  require('./runtime-env.cjs')();
  const port = Number(process.env.API_PORT || 5173);
  const running = await fetch(`http://127.0.0.1:${port}/api/healthz`, {signal: AbortSignal.timeout(2000)}).catch(() => null);
  if (running?.ok) throw Error('TeleCUS ya está abierto. Deténlo con npm run stop y vuelve a ejecutar este comando para aplicar la dirección del túnel.');
  process.env.APP_ALLOWED_ORIGINS = origins[0];
  require('./start.cjs');
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
