// First boot of a fresh deployment: load the demo data when the database has no
// users yet. Runs inside the host's private network, so the database never has to
// accept outside connections. Needs SEED_PASSWORD (the README's dev password is public).
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL);
const schema = url.searchParams.get('schema') ?? 'public';
url.searchParams.delete('schema');

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
let users = 0;
try {
  const res = await client.query(`select count(*)::int as n from "${schema}"."users"`);
  users = res.rows[0].n;
} finally {
  await client.end();
}

if (users > 0) {
  console.log(`seed-if-empty: ${users} users found, skipping`);
} else if (!process.env.SEED_PASSWORD) {
  console.log('seed-if-empty: database is empty but SEED_PASSWORD is not set, skipping');
} else {
  console.log('seed-if-empty: empty database, loading demo data');
  // The seed refuses NODE_ENV=production because it wipes data; the table is empty here.
  const run = spawnSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NODE_ENV: 'development' },
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
