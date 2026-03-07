import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import type { PlanetScaleDatabase } from './driver.ts';

export async function migrate<TSchema extends Record<string, unknown>>(
	db: PlanetScaleDatabase<TSchema>,
	config: MigrationConfig,
) {
	const migrations = readMigrationFiles(config);

	await db.dialect.migrate(migrations, db.session, config);
}

export async function rollback<TSchema extends Record<string, unknown>>(
	db: PlanetScaleDatabase<TSchema>,
	config: MigrationConfig,
	steps?: number,
) {
	const migrations = readMigrationFiles(config);
	await db.dialect.rollback(migrations, db.session, config, steps);
}
