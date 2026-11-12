// The `seed` job of docker-compose.yml (D-042): runs after the migrations and before the API starts, on every
// `docker compose up`.
//   1. seed-world: the 40 securities, their prices, USD/ILS, the calendar and the clock (D-003). Safe to run again.
//   2. the sample game (D-038), ONLY on a world with no orders yet. The sample game starts the world over, so run on
//      every `up` it would wipe the game played since the last one.
//
// It runs inside the db container's network (`network_mode: service:db`), so DATABASE_URL is a localhost URL and the
// sample game's safety checks (D-033) pass for the reason they exist: the database really is on this machine.
//
//   docker compose up              runs it
//   docker compose run --rm seed   runs it again

import { execFileSync } from 'node:child_process';
import pg from 'pg';

// A script that fails prints its own reason and exits non-zero; execFileSync then throws, the job fails, and the
// API doesn't start on a half-seeded database.
function run(script: string): void {
  execFileSync('npx', ['tsx', script], { stdio: 'inherit' });
}

async function orderCount(): Promise<number> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
    return rows[0].n;
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  console.log('Seed 1/2: the world (securities, prices, USD/ILS, calendar, clock)');
  run('scripts/seed-world.ts');

  const orders = await orderCount();
  if (orders > 0) {
    console.log(`Seed 2/2: skipped. The world already has ${orders} orders, and the sample game would wipe them.`);
    console.log('To start over with a fresh sample game: docker compose down -v && docker compose up');
    return;
  }
  console.log('Seed 2/2: the sample game (D-038), 40 players trade the world\'s first month');
  run('scripts/seed-sample-game.ts');
}

main().catch((err: unknown) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
