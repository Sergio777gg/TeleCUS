import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Database } from './database.js';
import { Profile, Role } from './types.js';
import { config } from './config.js';
import type { IdentityPort } from './ports/application.js';
export class AuthService implements IdentityPort {
  private registrationChecks=new Set<string>();
  constructor(private db: Database, private cfg: ReturnType<typeof config>,private claimRegistration?:(id:string)=>Promise<void>) {}
  issueDemo(id: string) {
    const data = Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now()/1000)+3600, aud: 'telecus-local-demo' })).toString('base64url');
    return `demo.${data}.${createHmac('sha256', this.cfg.demoSecret).update(data).digest('base64url')}`;
  }
  async authenticate(authorization: unknown): Promise<Profile> {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new UnauthorizedException('Inicia sesión para continuar.');
    const token = authorization.slice(7);
    if (this.cfg.mode === 'demo') {
      const [prefix, data, signature, extra] = token.split('.');
      if (prefix !== 'demo' || !data || !signature || extra) throw new UnauthorizedException('Sesión de prueba inválida.');
      const expected = createHmac('sha256', this.cfg.demoSecret).update(data).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Sesión inválida.');
      let payload: any;
      try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw new UnauthorizedException('Sesión inválida.'); }
      if (payload.aud !== 'telecus-local-demo' || !Number.isInteger(payload.exp) || payload.exp < Date.now()/1000) throw new UnauthorizedException('Tu sesión terminó.');
      const [profile] = await this.db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1', [payload.sub]);
      if (!profile || !profile.active) throw new ForbiddenException('Cuenta inactiva.');
      return { ...profile, active: true };
    }
    if (!this.cfg.supabaseUrl || !this.cfg.supabaseKey) throw new UnauthorizedException('Falta configurar el acceso.');
    const headers = { apikey: this.cfg.supabaseKey, Authorization: `Bearer ${token}` };
    const userResponse = await fetch(`${this.cfg.supabaseUrl}/auth/v1/user`, { headers, signal: AbortSignal.timeout(10000) });
    if (!userResponse.ok) throw new UnauthorizedException('Tu sesión terminó.');
    const user = await userResponse.json() as any;
    if(this.claimRegistration&&!this.registrationChecks.has(user.id)){
      await this.claimRegistration(user.id);if(this.registrationChecks.size>=1000)this.registrationChecks.clear();this.registrationChecks.add(user.id);
    }
    const parameters = new URLSearchParams({ id: `eq.${user.id}`, select: 'id,email,full_name,role,active', limit: '1' });
    const profileResponse = await fetch(`${this.cfg.supabaseUrl}/rest/v1/profiles?${parameters}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!profileResponse.ok) throw new ForbiddenException('No fue posible consultar tu perfil.');
    const [profile] = await profileResponse.json() as any[];
    if (!profile?.id || profile.active === false || !['PATIENT','ADMIN','DOCTOR'].includes(profile.role)) throw new ForbiddenException('Perfil no disponible.');
    return { ...profile, full_name:profile.full_name||user.user_metadata?.full_name||profile.email||user.email||'Usuario TeleCUS', email:profile.email||user.email||'', active: true, token };
  }
  async demoLogin(role: Role) {
    if (this.cfg.mode !== 'demo') throw new ForbiddenException('El acceso de prueba está deshabilitado.');
    if (!['PATIENT','ADMIN','DOCTOR'].includes(role)) throw new ForbiddenException('Rol inválido.');
    const [profile] = await this.db.query('SELECT * FROM telecus_demo_profiles WHERE role=$1 ORDER BY id LIMIT 1', [role]);
    return { token: this.issueDemo(profile.id), profile: { ...profile, active: true } };
  }
}
