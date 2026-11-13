-- Diario: tablas y permisos para sincronizar.
-- Pégalo completo en Supabase → SQL Editor → Run. Se puede ejecutar más de una vez.

create table if not exists public.boards (
  id        text primary key,
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  name      text,
  created   bigint,
  updated   bigint,
  deleted   boolean not null default false,
  srv       timestamptz not null default now()
);

create table if not exists public.items (
  id        text primary key,
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  board_id  text,
  type      text,
  x         double precision,
  y         double precision,
  w         double precision,
  text      text,
  blob_id   text,
  created   bigint,
  updated   bigint,
  deleted   boolean not null default false,
  srv       timestamptz not null default now()
);

create index if not exists boards_user_srv on public.boards (user_id, srv);
create index if not exists items_user_srv  on public.items  (user_id, srv);

-- "srv" = hora del servidor en cada cambio; así cada dispositivo sabe qué le falta.
create or replace function public.set_srv() returns trigger
language plpgsql as $$
begin
  new.srv := clock_timestamp();
  return new;
end $$;

drop trigger if exists boards_srv on public.boards;
create trigger boards_srv before insert or update on public.boards
  for each row execute function public.set_srv();

drop trigger if exists items_srv on public.items;
create trigger items_srv before insert or update on public.items
  for each row execute function public.set_srv();

-- Cada usuario solo ve y modifica lo suyo.
alter table public.boards enable row level security;
alter table public.items  enable row level security;

drop policy if exists "boards propios" on public.boards;
create policy "boards propios" on public.boards for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "items propios" on public.items;
create policy "items propios" on public.items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Archivos (imágenes y videos): carpeta privada, una subcarpeta por usuario.
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

drop policy if exists "media propios" on storage.objects;
create policy "media propios" on storage.objects for all
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- Cambios en tiempo real entre dispositivos.
do $$
begin
  begin alter publication supabase_realtime add table public.boards; exception when others then null; end;
  begin alter publication supabase_realtime add table public.items;  exception when others then null; end;
end $$;
