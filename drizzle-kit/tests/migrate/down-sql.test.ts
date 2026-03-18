import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { embeddedMigrations, writeResult } from 'src/cli/commands/migrate';
import type { Journal } from 'src/utils';

// Minimal CommonSchema stub accepted by writeResult
const minimalSchema: any = {
	version: '7',
	dialect: 'sqlite',
	tables: {},
	views: {},
	enums: {},
	_meta: { columns: {}, schemas: {}, tables: {} },
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-down-sql-test-'));
	fs.mkdirSync(path.join(tmpDir, 'meta'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJournal(dialect: string = 'sqlite'): Journal {
	return {
		version: '7',
		dialect: dialect as any,
		entries: [],
	};
}

describe('writeResult — down SQL file generation', () => {
	test('writes .down.sql file when downSqlStatements are provided', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE users (id INTEGER PRIMARY KEY)'],
			downSqlStatements: ['DROP TABLE users'],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'create_users',
		});

		const entries = journal.entries;
		expect(entries).toHaveLength(1);
		const tag = entries[0]!.tag;

		expect(fs.existsSync(path.join(tmpDir, `${tag}.sql`))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, `${tag}.down.sql`))).toBe(true);

		const downContent = fs.readFileSync(path.join(tmpDir, `${tag}.down.sql`), 'utf8');
		expect(downContent).toContain('DROP TABLE users');
	});

	test('does NOT write .down.sql file when downSqlStatements is undefined', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE users (id INTEGER PRIMARY KEY)'],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'test_migration',
		});

		const tag = journal.entries[0]!.tag;
		expect(fs.existsSync(path.join(tmpDir, `${tag}.sql`))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, `${tag}.down.sql`))).toBe(false);
	});

	test('sets hasDown: true in journal entry when downSqlStatements are provided', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE t (id INTEGER)'],
			downSqlStatements: ['DROP TABLE t'],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'test_migration',
		});

		const entry = journal.entries[0]!;
		expect(entry.hasDown).toBe(true);
	});

	test('does NOT set hasDown when downSqlStatements is undefined', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE t (id INTEGER)'],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'test_migration',
		});

		const entry = journal.entries[0]!;
		expect(entry.hasDown).toBeUndefined();
	});

	test('does NOT set hasDown when downSqlStatements is empty array', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE t (id INTEGER)'],
			downSqlStatements: [],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'test_migration',
		});

		const entry = journal.entries[0]!;
		expect(entry.hasDown).toBeUndefined();

		const tag = entry.tag;
		expect(fs.existsSync(path.join(tmpDir, `${tag}.down.sql`))).toBe(false);
	});

	test('respects breakpoints delimiter in .down.sql', () => {
		const journal = makeJournal();
		writeResult({
			cur: minimalSchema,
			sqlStatements: ['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER)'],
			downSqlStatements: ['DROP TABLE b', 'DROP TABLE a'],
			journal,
			outFolder: tmpDir,
			breakpoints: true,
			prefixMode: 'index',
			name: 'test_migration',
		});

		const tag = journal.entries[0]!.tag;
		const downContent = fs.readFileSync(path.join(tmpDir, `${tag}.down.sql`), 'utf8');
		expect(downContent).toContain('--> statement-breakpoint');
	});
});

describe('embeddedMigrations — down SQL bundling', () => {
	test('includes downMigrations block when entries have hasDown', () => {
		const journal: Journal = {
			version: '7',
			dialect: 'sqlite',
			entries: [
				{ idx: 0, version: '7', when: 1000, tag: '0000_test', breakpoints: true, hasDown: true },
			],
		};

		const output = embeddedMigrations(journal);

		expect(output).toContain("import d0000 from './0000_test.down.sql'");
		expect(output).toContain('downMigrations');
		expect(output).toContain('m0000: d0000');
	});

	test('omits downMigrations block when no entries have hasDown', () => {
		const journal: Journal = {
			version: '7',
			dialect: 'sqlite',
			entries: [
				{ idx: 0, version: '7', when: 1000, tag: '0000_test', breakpoints: true },
			],
		};

		const output = embeddedMigrations(journal);

		expect(output).not.toContain('downMigrations');
		expect(output).not.toContain('.down.sql');
	});

	test('only imports down SQL for entries that have hasDown', () => {
		const journal: Journal = {
			version: '7',
			dialect: 'sqlite',
			entries: [
				{ idx: 0, version: '7', when: 1000, tag: '0000_no_down', breakpoints: true },
				{ idx: 1, version: '7', when: 2000, tag: '0001_has_down', breakpoints: true, hasDown: true },
			],
		};

		const output = embeddedMigrations(journal);

		expect(output).toContain("import d0001 from './0001_has_down.down.sql'");
		expect(output).not.toContain("import d0000 from './0000_no_down.down.sql'");
		expect(output).toContain('downMigrations');
		expect(output).toContain('m0001: d0001');
		expect(output).not.toContain('d0000');
	});

	test('adds expo header for expo driver', () => {
		const journal: Journal = {
			version: '7',
			dialect: 'sqlite',
			entries: [],
		};

		const output = embeddedMigrations(journal, 'expo');
		expect(output).toContain('Expo/React Native');
	});
});
