import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import type { SQLJsDatabase } from './driver.ts';

export function migrate<TSchema extends Record<string, unknown>>(
	db: SQLJsDatabase<TSchema>,
	config: MigrationConfig,
) {
	const migrations = readMigrationFiles(config);
	db.dialect.migrate(migrations, db.session, config);
}

export function rollback<TSchema extends Record<string, unknown>>(
	db: SQLJsDatabase<TSchema>,
	config: MigrationConfig,
	steps?: number,
) {
	const migrations = readMigrationFiles(config);
	db.dialect.rollback(migrations, db.session, config, steps);
}
