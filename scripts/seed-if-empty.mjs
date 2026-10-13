// First boot of a fresh deployment (or RESEED_DEMO=1): load the demo data when the database has no
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

// RESEED_DEMO=1 reloads the demo data once (the seed wipes the tables first). Remove it afterwards.
const reseed = process.env.RESEED_DEMO === '1';

if (users > 0 && !reseed) {
  console.log(`seed-if-empty: ${users} users found, skipping`);
} else if (!process.env.SEED_PASSWORD) {
  console.log('seed-if-empty: database is empty but SEED_PASSWORD is not set, skipping');
} else {
  console.log(reseed ? 'seed-if-empty: RESEED_DEMO=1, reloading demo data' : 'seed-if-empty: empty database, loading demo data');
  // The seed refuses NODE_ENV=production because it wipes data; the table is empty here.
  const run = spawnSync('npx', ['tsx', 'prisma/seed.ts'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NODE_ENV: 'development' },
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
