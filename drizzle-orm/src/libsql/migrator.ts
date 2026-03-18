import { DrizzleError } from '~/errors.ts';
import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import { sql } from '~/sql/sql.ts';
import type { LibSQLDatabase } from './driver.ts';

export async function migrate<TSchema extends Record<string, unknown>>(
	db: LibSQLDatabase<TSchema>,
	config: MigrationConfig,
) {
	const migrations = readMigrationFiles(config);
	const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';

	const migrationTableCreate = sql`
		CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`;
	await db.session.run(migrationTableCreate);

	const dbMigrations = await db.values<[number, string, string]>(
		sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
	);

	const lastDbMigration = dbMigrations[0] ?? undefined;

	const statementToBatch = [];

	for (const migration of migrations) {
		if (!lastDbMigration || Number(lastDbMigration[2])! < migration.folderMillis) {
			for (const stmt of migration.sql) {
				statementToBatch.push(db.run(sql.raw(stmt)));
			}

			statementToBatch.push(
				db.run(
					sql`INSERT INTO ${
						sql.identifier(migrationsTable)
					} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
				),
			);
		}
	}

	await db.session.migrate(statementToBatch);
}

export async function rollback<TSchema extends Record<string, unknown>>(
	db: LibSQLDatabase<TSchema>,
	config: MigrationConfig,
	steps: number = 1,
) {
	const migrations = readMigrationFiles(config);
	const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';

	const dbMigrations = await db.values<[number, string, string]>(
		sql`SELECT id, hash, created_at FROM ${
			sql.identifier(migrationsTable)
		} ORDER BY created_at DESC LIMIT ${sql.raw(String(steps))}`,
	);

	if (dbMigrations.length === 0) {
		return;
	}

	const statementToBatch = [];
	for (const dbMigration of dbMigrations) {
		const meta = migrations.find((m) => m.hash === dbMigration[1]);
		if (!meta) {
			throw new DrizzleError({
				message: `Cannot rollback migration with hash ${dbMigration[1]}: migration file not found`,
			});
		}
		if (!meta.downSql || meta.downSql.length === 0) {
			throw new DrizzleError({
				message: `Cannot rollback migration ${dbMigration[1]}: no down SQL available. Add a .down.sql file alongside the migration.`,
			});
		}
		for (const stmt of [...meta.downSql].reverse()) {
			statementToBatch.push(db.run(sql.raw(stmt)));
		}
		statementToBatch.push(
			db.run(
				sql`DELETE FROM ${sql.identifier(migrationsTable)} WHERE hash = ${dbMigration[1]}`,
			),
		);
	}

	await db.session.migrate(statementToBatch);
}
