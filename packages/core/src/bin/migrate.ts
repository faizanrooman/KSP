import { migrate } from '../db/migrate.js';

migrate()
  .then((r) => {
    console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already applied`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
