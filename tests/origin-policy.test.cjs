const {test} = require('node:test'), assert = require('node:assert/strict');
test('solo acepta orígenes HTTPS completos y explícitos para el acceso adicional', async () => {
  const {parseAdditionalOrigins} = await import('../apps/backend/dist/origin-policy.js');
  assert.deepEqual(parseAdditionalOrigins(), []);
  assert.deepEqual(parseAdditionalOrigins(' https://mi-tunel.devtunnels.ms/,https://mi-tunel.devtunnels.ms '), ['https://mi-tunel.devtunnels.ms']);
  for (const value of ['*', 'https://*.devtunnels.ms', 'http://mi-tunel.devtunnels.ms', 'https://mi-tunel.devtunnels.ms/ruta', 'https://user:password@mi-tunel.devtunnels.ms', 'https://mi-tunel.devtunnels.ms?x=1', 'https://mi-tunel.devtunnels.ms#x']) {
    assert.throws(() => parseAdditionalOrigins(value));
  }
});
test('el túnel autorizado no permite otros dominios y conserva las restricciones de producción', async () => {
  const {originAllowed} = await import('../apps/backend/dist/origin-policy.js');
  const cfg = {origin:'http://localhost:5173', additionalOrigins:['https://mi-tunel.devtunnels.ms'], mode:'supabase-readonly', port:5173};
  assert.equal(originAllowed(cfg.origin, cfg), true);
  assert.equal(originAllowed(cfg.additionalOrigins[0], cfg), true);
  for (const origin of ['https://otro-tunel.devtunnels.ms', 'https://mi-tunel.devtunnels.ms.attacker.test', 'null', 'http://127.0.0.1:5173']) assert.equal(originAllowed(origin, cfg), false);
  assert.equal(originAllowed('http://127.0.0.1:5173', {...cfg, mode:'demo'}), true);
  assert.equal(originAllowed('https://otro-tunel.devtunnels.ms', {...cfg, mode:'demo'}), false);
});
