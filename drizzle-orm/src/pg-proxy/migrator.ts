import { DrizzleError } from '~/errors.ts';
import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import { sql } from '~/sql/sql.ts';
import type { PgRemoteDatabase } from './driver.ts';

export type ProxyMigrator = (migrationQueries: string[]) => Promise<void>;

export async function migrate<TSchema extends Record<string, unknown>>(
	db: PgRemoteDatabase<TSchema>,
	callback: ProxyMigrator,
	config: MigrationConfig,
) {
	const migrations = readMigrationFiles(config);

	const migrationTableCreate = sql`
		CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`;

	await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
	await db.execute(migrationTableCreate);

	const dbMigrations = await db.execute<{
		id: number;
		hash: string;
		created_at: string;
	}>(
		sql`SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
	);

	const lastDbMigration = dbMigrations[0] ?? undefined;

	const queriesToRun: string[] = [];

	for (const migration of migrations) {
		if (
			!lastDbMigration
			|| Number(lastDbMigration.created_at)! < migration.folderMillis
		) {
			queriesToRun.push(
				...migration.sql,
				`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES('${migration.hash}', '${migration.folderMillis}')`,
			);
		}
	}

	await callback(queriesToRun);
}

export async function rollback<TSchema extends Record<string, unknown>>(
	db: PgRemoteDatabase<TSchema>,
	callback: ProxyMigrator,
	config: MigrationConfig,
	steps: number = 1,
) {
	const migrations = readMigrationFiles(config);

	const dbMigrations = await db.execute<{
		id: number;
		hash: string;
		created_at: string;
	}>(
		sql`SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT ${
			sql.raw(String(steps))
		}`,
	);

	if (dbMigrations.length === 0) {
		return;
	}

	const queriesToRun: string[] = [];
	for (const dbMigration of dbMigrations) {
		const meta = migrations.find((m) => m.hash === dbMigration.hash);
		if (!meta) {
			throw new DrizzleError({
				message: `Cannot rollback migration with hash ${dbMigration.hash}: migration file not found`,
			});
		}
		if (!meta.downSql || meta.downSql.length === 0) {
			throw new DrizzleError({
				message: `Cannot rollback migration ${dbMigration.hash}: no down SQL available. Add a .down.sql file alongside the migration.`,
			});
		}
		queriesToRun.push(
			...[...meta.downSql].reverse(),
			`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${dbMigration.hash}'`,
		);
	}

	await callback(queriesToRun);
}
