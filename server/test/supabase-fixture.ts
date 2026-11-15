import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';
export const OWNER = '00000000-0000-4000-8000-000000000001';
export async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;
 insert into auth.users values('${OWNER}');`);
  const sql = fs
    .readFileSync(path.join(PROJECT_ROOT, 'supabase/setup.sql'), 'utf8')
    .replace(/^\uFEFF/, '');
  await db.exec(sql);
  return { db, sql };
}
