import { DrizzleError } from '~/errors.ts';
import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import { sql } from '~/sql/sql.ts';
import type { SingleStoreRemoteDatabase } from './driver.ts';

export type ProxyMigrator = (migrationQueries: string[]) => Promise<void>;

export async function migrate<TSchema extends Record<string, unknown>>(
	db: SingleStoreRemoteDatabase<TSchema>,
	callback: ProxyMigrator,
	config: MigrationConfig,
) {
	const migrations = readMigrationFiles(config);

	const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';
	const migrationTableCreate = sql`
		create table if not exists ${sql.identifier(migrationsTable)} (
			id serial primary key,
			hash text not null,
			created_at bigint
		)
	`;
	await db.execute(migrationTableCreate);

	const dbMigrations = await db.select({
		id: sql.raw('id'),
		hash: sql.raw('hash'),
		created_at: sql.raw('created_at'),
	}).from(sql.identifier(migrationsTable).getSQL()).orderBy(
		sql.raw('created_at desc'),
	).limit(1);

	const lastDbMigration = dbMigrations[0];

	const queriesToRun: string[] = [];

	for (const migration of migrations) {
		if (
			!lastDbMigration
			|| Number(lastDbMigration.created_at) < migration.folderMillis
		) {
			queriesToRun.push(
				...migration.sql,
				`insert into ${
					sql.identifier(migrationsTable).value
				} (\`hash\`, \`created_at\`) values('${migration.hash}', '${migration.folderMillis}')`,
			);
		}
	}

	await callback(queriesToRun);
}

export async function rollback<TSchema extends Record<string, unknown>>(
	db: SingleStoreRemoteDatabase<TSchema>,
	callback: ProxyMigrator,
	config: MigrationConfig,
	steps: number = 1,
) {
	const migrations = readMigrationFiles(config);
	const migrationsTable = config.migrationsTable ?? '__drizzle_migrations';

	const dbMigrations = await db.select({
		id: sql.raw('id'),
		hash: sql.raw('hash'),
		created_at: sql.raw('created_at'),
	}).from(sql.identifier(migrationsTable).getSQL()).orderBy(
		sql.raw('created_at desc'),
	).limit(steps);

	if (dbMigrations.length === 0) {
		return;
	}

	const queriesToRun: string[] = [];
	for (const dbMigration of dbMigrations) {
		const meta = migrations.find((m) => m.hash === String(dbMigration.hash));
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
			`delete from ${sql.identifier(migrationsTable).value} where \`hash\` = '${dbMigration.hash}'`,
		);
	}

	await callback(queriesToRun);
}
