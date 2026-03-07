import { DrizzleError } from '~/errors.ts';
import type { MigrationMeta } from '~/migrator.ts';
import { sql } from '~/sql/index.ts';
import type { DrizzleSqliteDODatabase } from './driver.ts';

interface MigrationConfig {
	journal: {
		entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
	};
	migrations: Record<string, string>;
	downMigrations?: Record<string, string>;
}

function readMigrationFiles({ journal, migrations, downMigrations }: MigrationConfig): MigrationMeta[] {
	const migrationQueries: MigrationMeta[] = [];

	for (const journalEntry of journal.entries) {
		const key = `m${journalEntry.idx.toString().padStart(4, '0')}`;
		const query = migrations[key];

		if (!query) {
			throw new Error(`Missing migration: ${journalEntry.tag}`);
		}

		try {
			const result = query.split('--> statement-breakpoint').map((it) => {
				return it;
			});

			let downSql: string[] | undefined;
			const downQuery = downMigrations?.[key];
			if (downQuery?.trim()) {
				downSql = downQuery.trim().split('--> statement-breakpoint').map((it) => it);
			}

			migrationQueries.push({
				sql: result,
				downSql,
				bps: journalEntry.breakpoints,
				folderMillis: journalEntry.when,
				hash: '',
			});
		} catch {
			throw new Error(`Failed to parse migration: ${journalEntry.tag}`);
		}
	}

	return migrationQueries;
}

export async function migrate<
	TSchema extends Record<string, unknown>,
>(
	db: DrizzleSqliteDODatabase<TSchema>,
	config: MigrationConfig,
): Promise<void> {
	const migrations = readMigrationFiles(config);

	db.transaction((tx) => {
		try {
			const migrationsTable = '__drizzle_migrations';

			const migrationTableCreate = sql`
				CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
					id SERIAL PRIMARY KEY,
					hash text NOT NULL,
					created_at numeric
				)
			`;
			db.run(migrationTableCreate);

			const dbMigrations = db.values<[number, string, string]>(
				sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`,
			);

			const lastDbMigration = dbMigrations[0] ?? undefined;

			for (const migration of migrations) {
				if (!lastDbMigration || Number(lastDbMigration[2])! < migration.folderMillis) {
					for (const stmt of migration.sql) {
						db.run(sql.raw(stmt));
					}
					db.run(
						sql`INSERT INTO ${
							sql.identifier(migrationsTable)
						} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
					);
				}
			}
		} catch (error: any) {
			tx.rollback();
			throw error;
		}
	});
}

export async function rollback<
	TSchema extends Record<string, unknown>,
>(
	db: DrizzleSqliteDODatabase<TSchema>,
	config: MigrationConfig,
	steps: number = 1,
): Promise<void> {
	const migrations = readMigrationFiles(config);

	db.transaction((tx) => {
		try {
			const migrationsTable = '__drizzle_migrations';

			const dbMigrations = db.values<[number, string, string]>(
				sql`SELECT id, hash, created_at FROM ${
					sql.identifier(migrationsTable)
				} ORDER BY created_at DESC LIMIT ${sql.raw(String(steps))}`,
			);

			if (dbMigrations.length === 0) {
				return;
			}

			for (const dbMigration of dbMigrations) {
				const meta = migrations.find((m) => m.hash === dbMigration[1]);
				if (!meta) {
					throw new DrizzleError({
						message: `Cannot rollback migration with hash ${dbMigration[1]}: migration file not found`,
					});
				}
				if (!meta.downSql || meta.downSql.length === 0) {
					throw new DrizzleError({
						message: `Cannot rollback migration ${dbMigration[1]}: no down SQL available. Add down SQL to your migrations bundle.`,
					});
				}
				for (const stmt of [...meta.downSql].reverse()) {
					db.run(sql.raw(stmt));
				}
				db.run(
					sql`DELETE FROM ${sql.identifier(migrationsTable)} WHERE hash = ${dbMigration[1]}`,
				);
			}
		} catch (error: any) {
			tx.rollback();
			throw error;
		}
	});
}
