// Additional origins are explicit HTTPS addresses, never wildcard tunnel domains.
export function parseAdditionalOrigins(value = ''): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let url: URL;
    try { url = new URL(item); } catch { throw new Error('APP_ALLOWED_ORIGINS debe contener direcciones HTTPS completas.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
      throw new Error('APP_ALLOWED_ORIGINS solo permite orígenes HTTPS exactos, sin rutas ni comodines.');
    }
    return url.origin;
  }))];
}

export function originAllowed(origin: string, cfg: {origin: string; additionalOrigins: string[]; mode: string; port: number}): boolean {
  const origins = [cfg.origin, ...cfg.additionalOrigins];
  if (cfg.mode === 'demo') origins.push(`http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`);
  return origins.includes(origin);
}
