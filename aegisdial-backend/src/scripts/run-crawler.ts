import { buildCrawlers, runCrawlerOnce } from '../workers/scheduler.js';
import { shutdownDb } from '../lib/db.js';
import { shutdownCache } from '../lib/cache.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  const crawlers = buildCrawlers();
  const targets = name ? crawlers.filter((c) => c.name === name) : crawlers;
  if (targets.length === 0) {
    console.error(`no crawler matched: ${name ?? '(all)'}`);
    console.error(`available: ${crawlers.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
  for (const c of targets) {
    if (!c.enabled) {
      console.log(`[${c.name}] skipped — disabled (missing credentials)`);
      continue;
    }
    await runCrawlerOnce(c);
  }
  await shutdownDb();
  await shutdownCache();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
