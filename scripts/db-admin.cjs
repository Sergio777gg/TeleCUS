const fs = require('node:fs/promises');
const { Client } = require('pg');
module.exports = async function admin(provided) {
  let password=provided||''; if(provided===undefined)for await (const chunk of process.stdin) password+=chunk;
  password=password.replace(/\r?\n$/, '');
  if(!password)throw new Error('Falta la credencial de administración temporal.');
  const client=new Client({host:process.env.TELECUS_DATABASE_ADDRESS || 'aws-0-us-east-1.pooler.supabase.com',port:5432,
    user:'postgres.nyqbvpjkdfdzyktieeuf',database:'postgres',password,connectionTimeoutMillis:10000,
    application_name:'telecus-integration-setup',ssl:{rejectUnauthorized:true,servername:'aws-0-us-east-1.pooler.supabase.com',ca:await fs.readFile('data/supabase-ca.crt','utf8')}});
  password=''; await client.connect(); return client;
};
