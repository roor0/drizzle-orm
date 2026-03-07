import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate, rollback } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// ─── helpers ─────────────────────────────────────────────────────────────────

function tableExists(client: Database.Database, name: string): boolean {
	const row = client
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(name) as { name: string } | undefined;
	return row !== undefined;
}

function appliedMigrations(client: Database.Database): string[] {
	try {
		return (
			client
				.prepare(`SELECT hash FROM __drizzle_migrations ORDER BY created_at ASC`)
				.all() as { hash: string }[]
		).map((r) => r.hash);
	} catch {
		return [];
	}
}

// ─── readMigrationFiles — unit tests ─────────────────────────────────────────

describe('readMigrationFiles', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-read-test-'));
		fs.mkdirSync(path.join(tmpDir, 'meta'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeFixture(tag: string, sql: string, downSql?: string) {
		fs.writeFileSync(path.join(tmpDir, `${tag}.sql`), sql);
		if (downSql !== undefined) {
			fs.writeFileSync(path.join(tmpDir, `${tag}.down.sql`), downSql);
		}
	}

	function writeJournal(tags: string[]) {
		const entries = tags.map((tag, idx) => ({
			idx,
			version: '5',
			when: 1700000000000 + idx * 1000,
			tag,
			breakpoints: true,
		}));
		fs.writeFileSync(
			path.join(tmpDir, 'meta', '_journal.json'),
			JSON.stringify({ version: '5', dialect: 'sqlite', entries }),
		);
	}

	test('populates downSql when .down.sql file exists', () => {
		writeJournal(['0000_test']);
		writeFixture('0000_test', 'CREATE TABLE t (id INTEGER)', 'DROP TABLE t');

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas).toHaveLength(1);
		expect(metas[0]!.downSql).toEqual(['DROP TABLE t']);
	});

	test('leaves downSql undefined when .down.sql file is absent', () => {
		writeJournal(['0000_test']);
		writeFixture('0000_test', 'CREATE TABLE t (id INTEGER)');

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas[0]!.downSql).toBeUndefined();
	});

	test('leaves downSql undefined when .down.sql file is empty', () => {
		writeJournal(['0000_test']);
		writeFixture('0000_test', 'CREATE TABLE t (id INTEGER)', '');

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas[0]!.downSql).toBeUndefined();
	});

	test('leaves downSql undefined when .down.sql file is whitespace only', () => {
		writeJournal(['0000_test']);
		writeFixture('0000_test', 'CREATE TABLE t (id INTEGER)', '   \n  ');

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas[0]!.downSql).toBeUndefined();
	});

	test('splits downSql on statement-breakpoint delimiter', () => {
		writeJournal(['0000_test']);
		writeFixture(
			'0000_test',
			'CREATE TABLE a (id INTEGER)',
			'DROP TABLE b\n--> statement-breakpoint\nDROP TABLE a',
		);

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas[0]!.downSql).toHaveLength(2);
		expect(metas[0]!.downSql![0]).toContain('DROP TABLE b');
		expect(metas[0]!.downSql![1]).toContain('DROP TABLE a');
	});

	test('reads downSql for multiple migrations independently', () => {
		writeJournal(['0000_first', '0001_second']);
		writeFixture('0000_first', 'CREATE TABLE a (id INTEGER)', 'DROP TABLE a');
		writeFixture('0001_second', 'CREATE TABLE b (id INTEGER)'); // no down SQL

		const metas = readMigrationFiles({ migrationsFolder: tmpDir });
		expect(metas[0]!.downSql).toEqual(['DROP TABLE a']);
		expect(metas[1]!.downSql).toBeUndefined();
	});
});

// ─── rollback integration tests ──────────────────────────────────────────────

describe('rollback — better-sqlite3', () => {
	const MIGRATIONS_FOLDER = './drizzle2/sqlite-rollback';
	let client: Database.Database;
	let db: ReturnType<typeof drizzle>;

	beforeEach(() => {
		client = new Database(':memory:');
		db = drizzle(client);
		client.exec(`DROP TABLE IF EXISTS rollback_users`);
		client.exec(`DROP TABLE IF EXISTS rollback_posts`);
		client.exec(`DROP TABLE IF EXISTS __drizzle_migrations`);
	});

	afterEach(() => {
		client.close();
	});

	test('migrate then rollback(1) removes the last migration table', () => {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

		expect(tableExists(client, 'rollback_users')).toBe(true);
		expect(tableExists(client, 'rollback_posts')).toBe(true);
		expect(appliedMigrations(client)).toHaveLength(2);

		rollback(db, { migrationsFolder: MIGRATIONS_FOLDER }, 1);

		expect(tableExists(client, 'rollback_posts')).toBe(false);
		expect(tableExists(client, 'rollback_users')).toBe(true);
		expect(appliedMigrations(client)).toHaveLength(1);
	});

	test('rollback(2) undoes both migrations', () => {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		rollback(db, { migrationsFolder: MIGRATIONS_FOLDER }, 2);

		expect(tableExists(client, 'rollback_users')).toBe(false);
		expect(tableExists(client, 'rollback_posts')).toBe(false);
		expect(appliedMigrations(client)).toHaveLength(0);
	});

	test('rollback with default steps=1 rolls back one migration', () => {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		rollback(db, { migrationsFolder: MIGRATIONS_FOLDER });

		expect(appliedMigrations(client)).toHaveLength(1);
	});

	test('rollback when no migrations applied is a no-op', () => {
		// create the tracking table but no migrations applied
		client.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)`);

		expect(() => rollback(db, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();
		expect(appliedMigrations(client)).toHaveLength(0);
	});

	test('rollback then migrate re-applies the migration', () => {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		rollback(db, { migrationsFolder: MIGRATIONS_FOLDER }, 1);

		expect(tableExists(client, 'rollback_posts')).toBe(false);

		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

		expect(tableExists(client, 'rollback_posts')).toBe(true);
		expect(appliedMigrations(client)).toHaveLength(2);
	});

	test('rollback throws when migration file not found by hash', () => {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

		// Corrupt the hash in the tracking table so it won't match
		client.exec(`UPDATE __drizzle_migrations SET hash='deadbeef' WHERE rowid=(SELECT MAX(rowid) FROM __drizzle_migrations)`);

		expect(() => rollback(db, { migrationsFolder: MIGRATIONS_FOLDER })).toThrowError(
			/migration file not found/i,
		);
	});

	test('rollback throws when migration has no down SQL', () => {
		// Set up a migration folder with no .down.sql files
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-nodown-'));
		fs.mkdirSync(path.join(tmpDir, 'meta'));

		const upSql = `CREATE TABLE nodown_table (id INTEGER PRIMARY KEY)`;
		fs.writeFileSync(path.join(tmpDir, '0000_nodown.sql'), upSql);

		const hash = crypto.createHash('sha256').update(upSql).digest('hex');
		const journal = {
			version: '5',
			dialect: 'sqlite',
			entries: [{ idx: 0, version: '5', when: 1700000000000, tag: '0000_nodown', breakpoints: true }],
		};
		fs.writeFileSync(path.join(tmpDir, 'meta', '_journal.json'), JSON.stringify(journal));

		try {
			migrate(db, { migrationsFolder: tmpDir });
			expect(tableExists(client, 'nodown_table')).toBe(true);

			expect(() => rollback(db, { migrationsFolder: tmpDir })).toThrowError(
				/no down SQL available/i,
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
