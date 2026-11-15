begin;
-- Agendador Junior. Execute no SQL Editor; nenhuma credencial vai neste arquivo.
create table if not exists public.scheduler_collections (
 owner_id uuid not null references auth.users(id) on delete cascade,
 mode text not null check (mode in ('','real','demo')),
 name text not null check (name in ('settings','oauth-used','batches','tasks','media','idempotency','connections','demo-remote','manual')),
 revision bigint not null default 0, primary key(owner_id,mode,name)
);
create table if not exists public.scheduler_records (
 owner_id uuid not null, mode text not null, collection text not null,
 id text not null, position integer not null, data jsonb not null check(jsonb_typeof(data)='object'),
 primary key(owner_id,mode,collection,id),
 foreign key(owner_id,mode,collection) references public.scheduler_collections on delete cascade
);
create table if not exists public.scheduler_sessions (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null, revoked_at timestamptz
);
create index if not exists scheduler_sessions_owner on public.scheduler_sessions(owner_id,expires_at);
create table if not exists public.manual_batches (
 owner_id uuid not null references auth.users(id) on delete cascade, id text not null,
 timezone text not null default 'America/Sao_Paulo' check(timezone='America/Sao_Paulo'),
 publish_time time not null default '12:00' check(publish_time='12:00'),
 primary key(owner_id,id)
);
create table if not exists public.manual_items (
 owner_id uuid not null, id text not null, batch_id text not null, position integer not null,
 planned_date date not null, scheduled_at timestamptz not null,
 original_name text not null, title text not null, description text not null,
 primary key(owner_id,id), foreign key(owner_id,batch_id) references public.manual_batches on delete cascade
);
create index if not exists manual_items_date on public.manual_items(owner_id,scheduled_at,position);
create table if not exists public.manual_platforms (
 owner_id uuid not null, item_id text not null,
 platform text not null check(platform in ('facebook','youtube','instagram','tiktok')),
 title text not null, description text not null,
 state text not null check(state in ('pending','done')),
 primary key(owner_id,item_id,platform),
 foreign key(owner_id,item_id) references public.manual_items on delete cascade
);
-- Uma única transação mantém o documento usado pelo app e sua projeção relacional.
create or replace function public.scheduler_load(p_owner uuid,p_mode text,p_name text)
returns jsonb language sql stable set search_path=public,pg_temp as $$
 select jsonb_build_object('revision',coalesce((select revision from scheduler_collections where owner_id=p_owner and mode=p_mode and name=p_name),0),
 'items',coalesce((select jsonb_agg(data order by position,id) from scheduler_records where owner_id=p_owner and mode=p_mode and collection=p_name),'[]'::jsonb));
$$;
create or replace function public.scheduler_commit(p_owner uuid,p_mode text,p_name text,p_expected bigint,p_items jsonb)
returns bigint language plpgsql set search_path=public,pg_temp as $$
declare v_revision bigint; r jsonb; platform_entry record; v_batch text; v_position integer := 0;
begin
 if jsonb_typeof(p_items) <> 'array' then raise exception 'items deve ser array'; end if;
 insert into scheduler_collections(owner_id,mode,name) values(p_owner,p_mode,p_name) on conflict do nothing;
 select revision into v_revision from scheduler_collections where owner_id=p_owner and mode=p_mode and name=p_name for update;
 if v_revision <> p_expected then return null; end if;
 delete from scheduler_records where owner_id=p_owner and mode=p_mode and collection=p_name;
 insert into scheduler_records select p_owner,p_mode,p_name,e->>'id',(n-1)::integer,e from jsonb_array_elements(p_items) with ordinality as a(e,n);
 if p_mode='real' and p_name='manual' then
  delete from manual_batches where owner_id=p_owner;
  for r in select value from jsonb_array_elements(p_items) loop
   v_batch := coalesce(r->>'batchId','legacy:'||(r->>'id'));
   insert into manual_batches(owner_id,id) values(p_owner,v_batch) on conflict do nothing;
   insert into manual_items values(p_owner,r->>'id',v_batch,v_position,(r->>'date')::date,
    ((r->>'date')::date + time '12:00') at time zone 'America/Sao_Paulo',r->>'originalName',r->>'title',r->>'description');
   for platform_entry in select key,value from jsonb_each(r->'platforms') loop
    insert into manual_platforms values(p_owner,r->>'id',platform_entry.key,r->>'title',r->>'description',
     case when platform_entry.value='true'::jsonb then 'done' else 'pending' end);
   end loop;
   v_position := v_position+1;
  end loop;
 end if;
 update scheduler_collections set revision=revision+1 where owner_id=p_owner and mode=p_mode and name=p_name returning revision into v_revision;
 return v_revision;
end $$;
-- Integrações mantêm o payload completo existente, inclusive textos e estados por rede.
create or replace view public.integration_batches with(security_invoker=true) as
 select owner_id,mode,id,data from public.scheduler_records where collection='batches';
create or replace view public.integration_items with(security_invoker=true) as
 select owner_id,mode,id as batch_id,item->>'id' as item_id,item from public.integration_batches cross join lateral jsonb_array_elements(data->'items') item;
create or replace view public.integration_platforms with(security_invoker=true) as
 select owner_id,mode,batch_id,item_id,p.key as platform,p.value as texts from public.integration_items cross join lateral jsonb_each(item->'platforms') p;
create or replace view public.integration_tasks with(security_invoker=true) as
 select owner_id,mode,id,data->>'platform' as platform,data->>'state' as state,data from public.scheduler_records where collection='tasks';
-- A API verifica Supabase Auth + Login_ADM antes de usar service_role.
-- Nenhum JWT do navegador tem acesso direto a dados ou tokens OAuth.
do $$ declare t text; begin
 foreach t in array array['scheduler_collections','scheduler_records','scheduler_sessions','manual_batches','manual_items','manual_platforms'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('drop policy if exists backend_only on public.%I',t);
  execute format('create policy backend_only on public.%I as restrictive for all to anon,authenticated using(false) with check(false)',t);
 end loop;
end $$;
revoke all on public.integration_batches,public.integration_items,public.integration_platforms,public.integration_tasks from public,anon,authenticated;
grant select on public.integration_batches,public.integration_items,public.integration_platforms,public.integration_tasks to service_role;
revoke all on function public.scheduler_load(uuid,text,text),public.scheduler_commit(uuid,text,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.scheduler_load(uuid,text,text),public.scheduler_commit(uuid,text,text,bigint,jsonb) to service_role;
-- Opcional para upload real. A agenda manual guarda somente nomes e não usa o bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('agendador-media','agendador-media',false,52428800,array['video/mp4','video/quicktime','image/jpeg'])
 on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists agendador_private on storage.objects;
create policy agendador_private on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id <> 'agendador-media') with check(bucket_id <> 'agendador-media');

commit;
