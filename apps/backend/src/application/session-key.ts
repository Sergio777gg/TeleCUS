import { createHash } from 'node:crypto';
import type { Profile } from '../types.js';
export const sessionKey=(user:Profile,id:string)=>createHash('sha256').update(`${user.id}|${user.role}|${id}`).digest('hex');
