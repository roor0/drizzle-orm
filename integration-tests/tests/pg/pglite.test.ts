import { PGlite } from '@electric-sql/pglite';
import { Name, sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate, rollback } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { skipTests } from '~/common';
import { tests, usersMigratorTable, usersTable } from './pg-common';
import { TestCache, TestGlobalCache, tests as cacheTests } from './pg-common-cache';

const ENABLE_LOGGING = false;

let db: PgliteDatabase;
let dbGlobalCached: PgliteDatabase;
let cachedDb: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
	client = new PGlite();
	db = drizzle(client, { logger: ENABLE_LOGGING });
	cachedDb = drizzle(client, {
		logger: ENABLE_LOGGING,
		cache: new TestCache(),
	});
	dbGlobalCached = drizzle(client, {
		logger: ENABLE_LOGGING,
		cache: new TestGlobalCache(),
	});
});

afterAll(async () => {
	await client?.close();
});

beforeEach((ctx) => {
	ctx.pg = {
		db,
	};
	ctx.cachedPg = {
		db: cachedDb,
		dbGlobalCached,
	};
});

test('migrator : default migration strategy', async () => {
	await db.execute(sql`drop table if exists all_columns`);
	await db.execute(
		sql`drop table if exists users12`,
	);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg' });

	await db.insert(usersMigratorTable).values({ name: 'John', email: 'email' });

	const result = await db.select().from(usersMigratorTable);

	expect(result).toEqual([{ id: 1, name: 'John', email: 'email' }]);

	await db.execute(sql`drop table all_columns`);
	await db.execute(sql`drop table users12`);
	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test('migrator : rollback(1) removes last migration', async () => {
	await db.execute(sql`drop table if exists "rollback_users"`);
	await db.execute(sql`drop table if exists "rollback_posts"`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg-rollback' });

	const afterMigrate = await db.execute(sql`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_name in ('rollback_users', 'rollback_posts')
		order by table_name
	`);
	expect(afterMigrate.rows).toHaveLength(2);

	await rollback(db, { migrationsFolder: './drizzle2/pg-rollback' }, 1);

	const afterRollback = await db.execute(sql`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_name in ('rollback_users', 'rollback_posts')
		order by table_name
	`);
	expect(afterRollback.rows.map((r: any) => r.table_name)).toEqual(['rollback_users']);

	const applied = await db.execute(sql`select hash from "drizzle"."__drizzle_migrations" order by created_at`);
	expect(applied.rows).toHaveLength(1);

	await db.execute(sql`drop table if exists "rollback_users"`);
	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test('migrator : rollback(2) undoes all migrations', async () => {
	await db.execute(sql`drop table if exists "rollback_users"`);
	await db.execute(sql`drop table if exists "rollback_posts"`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg-rollback' });
	await rollback(db, { migrationsFolder: './drizzle2/pg-rollback' }, 2);

	const tables = await db.execute(sql`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_name in ('rollback_users', 'rollback_posts')
	`);
	expect(tables.rows).toHaveLength(0);

	const applied = await db.execute(sql`select hash from "drizzle"."__drizzle_migrations" order by created_at`);
	expect(applied.rows).toHaveLength(0);

	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test('migrator : rollback then migrate re-applies', async () => {
	await db.execute(sql`drop table if exists "rollback_users"`);
	await db.execute(sql`drop table if exists "rollback_posts"`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg-rollback' });
	await rollback(db, { migrationsFolder: './drizzle2/pg-rollback' }, 1);

	const afterRollback = await db.execute(sql`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_name = 'rollback_posts'
	`);
	expect(afterRollback.rows).toHaveLength(0);

	await migrate(db, { migrationsFolder: './drizzle2/pg-rollback' });

	const afterReapply = await db.execute(sql`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_name = 'rollback_posts'
	`);
	expect(afterReapply.rows).toHaveLength(1);

	await db.execute(sql`drop table "rollback_users"`);
	await db.execute(sql`drop table "rollback_posts"`);
	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test('insert via db.execute + select via db.execute', async () => {
	await db.execute(sql`insert into ${usersTable} (${new Name(usersTable.name.name)}) values (${'John'})`);

	const result = await db.execute<{ id: number; name: string }>(sql`select id, name from "users"`);
	expect(Array.prototype.slice.call(result.rows)).toEqual([{ id: 1, name: 'John' }]);
});

test('insert via db.execute + returning', async () => {
	const result = await db.execute<{ id: number; name: string }>(
		sql`insert into ${usersTable} (${new Name(
			usersTable.name.name,
		)}) values (${'John'}) returning ${usersTable.id}, ${usersTable.name}`,
	);
	expect(Array.prototype.slice.call(result.rows)).toEqual([{ id: 1, name: 'John' }]);
});

test('insert via db.execute w/ query builder', async () => {
	const result = await db.execute<Pick<typeof usersTable.$inferSelect, 'id' | 'name'>>(
		db.insert(usersTable).values({ name: 'John' }).returning({ id: usersTable.id, name: usersTable.name }),
	);
	expect(Array.prototype.slice.call(result.rows)).toEqual([{ id: 1, name: 'John' }]);
});

skipTests([
	'migrator : default migration strategy',
	'migrator : migrate with custom schema',
	'migrator : migrate with custom table',
	'migrator : migrate with custom table and custom schema',
	'insert via db.execute + select via db.execute',
	'insert via db.execute + returning',
	'insert via db.execute w/ query builder',
	'all date and time columns without timezone first case mode string',
	'all date and time columns without timezone third case mode date',
	'test mode string for timestamp with timezone',
	'test mode date for timestamp with timezone',
	'test mode string for timestamp with timezone in UTC timezone',
	'test mode string for timestamp with timezone in different timezone',
	'view',
	'materialized view',
	'subquery with view',
	'mySchema :: materialized view',
	'select count()',
	// not working in 0.2.12
	'select with group by as sql + column',
	'select with group by as column + sql',
	'mySchema :: select with group by as column + sql',
]);

tests();
cacheTests();

beforeEach(async () => {
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`create schema public`);
	await db.execute(
		sql`
			create table users (
				id serial primary key,
				name text not null,
				verified boolean not null default false,
				jsonb jsonb,
				created_at timestamptz not null default now()
			)
		`,
	);
});
