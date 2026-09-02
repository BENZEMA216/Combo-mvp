// combo-v2 独立迁移入口：复用 canonical 0000-0011，再执行 db/v2-migrations。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMigrationCli } from './migrate.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigrationCli('v2').catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
