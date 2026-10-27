// Reads schema metadata only. The database password is supplied through stdin.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  let password = '';
  for await (const chunk of process.stdin) password += chunk;
  password = password.trim();
  if (!password) throw new Error('No database password was supplied.');
  const root = path.resolve(__dirname, '..');
  const sessionPooler = process.env.TELECUS_DATABASE_CONNECTION === 'session';
  const hostname = sessionPooler
    ? 'aws-0-us-east-1.pooler.supabase.com'
    : 'db.nyqbvpjkdfdzyktieeuf.supabase.co';
  const ca = await fs.readFile(path.join(root, 'data', 'supabase-ca.crt'), 'utf8');
  const client = new Client({
    host: process.env.TELECUS_DATABASE_ADDRESS || hostname,
    port: 5432,
    database: 'postgres',
    user: sessionPooler ? 'postgres.nyqbvpjkdfdzyktieeuf' : 'postgres',
    password,
    ssl: { rejectUnauthorized: true, servername: hostname, ca },
    connectionTimeoutMillis: 10000,
    application_name: 'telecus-schema-inspection',
  });
  password = '';
  let stage = 'connect';
  try {
    await client.connect();
    stage = 'metadata';
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '20s'");
    const query = await fs.readFile(path.join(root, 'scripts/sql/inspect-base.sql'), 'utf8');
    const result = await client.query(query);
    const document = JSON.parse(result.rows[0].telecus_schema);
    await client.query('ROLLBACK');
    stage = 'save';
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'supabase-schema.json'), JSON.stringify(document, null, 2));
    console.log(JSON.stringify({ status: 'ok', metadataSections: Object.keys(document), patientRowsRead: 0, databaseChanges: 0 }));
  } catch (error) {
    // Deliberately omit stack, connection strings and credentials.
    console.error(JSON.stringify({ status: 'failed', stage, code: error.code || error.name, message: error.message }));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
    client.connectionParameters.password = null;
  }
}

main().catch(() => {
  console.error('Schema inspection could not start.');
  process.exitCode = 1;
});
