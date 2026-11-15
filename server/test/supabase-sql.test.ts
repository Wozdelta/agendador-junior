import { beforeAll, afterAll, expect, it } from 'vitest';
import { database, OWNER } from './supabase-fixture.js';
let fixture: Awaited<ReturnType<typeof database>>;
beforeAll(async () => {
  fixture = await database();
}, 30000);
afterAll(async () => fixture?.db.close());
it('SQL completo é reexecutável; CAS, horários, textos e RLS são efetivos', async () => {
  const { db, sql } = fixture;
  await db.exec(sql);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `v${i}`,
    batchId: 'lote-5',
    date: `2026-12-${10 + i}`,
    originalName: `vídeo${i}.mp4`,
    title: 'Título',
    description: 'Legenda',
    platforms: { youtube: false, tiktok: i === 0 },
  }));
  const commit = async (rev: number) =>
    (
      await db.query<{ r: number | null }>(
        'select public.scheduler_commit($1,$2,$3,$4,$5::jsonb) r',
        [OWNER, 'real', 'manual', rev, JSON.stringify(rows)],
      )
    ).rows[0].r;
  expect(await commit(0)).toBe(1);
  expect(await commit(0)).toBeNull();
  const items = (
    await db.query<{ date: string }>(
      'select to_char(scheduled_at at time zone $1,$2) as date from manual_items order by position',
      ['America/Sao_Paulo', 'YYYY-MM-DD HH24:MI'],
    )
  ).rows;
  expect(items.map((x) => x.date)).toEqual(rows.map((x) => `${x.date} 12:00`));
  expect((await db.query('select * from manual_batches')).rows).toHaveLength(1);
  expect((await db.query('select * from manual_platforms')).rows).toHaveLength(10);
  expect(
    (await db.query("select state from manual_platforms where item_id='v0' order by platform"))
      .rows,
  ).toEqual([{ state: 'done' }, { state: 'pending' }]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await expect(db.query('select * from scheduler_records')).rejects.toThrow(/permission denied/);
    await expect(
      db.query('select scheduler_load($1,$2,$3)', [OWNER, 'real', 'manual']),
    ).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  }
  const policies = await db.query(
    "select tablename from pg_policies where policyname='backend_only'",
  );
  expect(policies.rows).toHaveLength(6);
});
