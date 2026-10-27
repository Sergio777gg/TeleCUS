import {createHmac,timingSafeEqual} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';
import type {ReviewSigner,StaffReview} from '../ports/workspace.js';
export class SignedStaffReview implements ReviewSigner {
  constructor(private key:string){if(key.length<32)throw new Error('Falta la clave de confirmaciones.');}
  seal(review:StaffReview){const body=Buffer.from(JSON.stringify(review)).toString('base64url');return body+'.'+createHmac('sha256',this.key).update('telecus.staff-review.v1\0'+body).digest('base64url');}
  open(token:string):StaffReview{
    try{if(typeof token!=='string'||token.length>12000)throw Error();const [body,signature,extra]=token.split('.');if(extra||!body||!signature)throw Error();const actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.key).update('telecus.staff-review.v1\0'+body).digest();if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const value=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(!value.id||!value.actor_id||!value.kind||!value.expires_at||!value.payload||!value.snapshot)throw Error();return value;}catch{throw new BadRequestException('La revisión no es válida. Revisa otra vez los datos.');}
  }
}
