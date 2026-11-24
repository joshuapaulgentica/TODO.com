-- supabase.sql : paste into Supabase > SQL Editor > New query, then click Run.
-- Accounts (email + password) are handled by Supabase Auth, so no users table is needed.

create table if not exists public.tasks (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 120),
  notes      text not null default '' check (char_length(notes) <= 500),
  progress   smallint not null default 0 check (progress between 0 and 100), -- percent done
  priority   text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  created_at timestamptz not null default now()
);

create index if not exists tasks_user_id_idx on public.tasks (user_id);

-- Row Level Security: each person can only see and change their OWN tasks
alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;

create policy "tasks_select_own" on public.tasks for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tasks_insert_own" on public.tasks for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tasks_update_own" on public.tasks for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "tasks_delete_own" on public.tasks for delete to authenticated
  using ((select auth.uid()) = user_id);


-- =====================================================================
-- NEW: photos and files for tasks (run the whole file again, it is safe)
-- =====================================================================

-- A private storage bucket: max 5 MB per file, only photos, PDF, text and Office files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-files', 'task-files', false, 5242880, array[
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Each person can only use files inside their own folder (folder name = their user id)
drop policy if exists "task_files_storage_select" on storage.objects;
drop policy if exists "task_files_storage_insert" on storage.objects;
drop policy if exists "task_files_storage_delete" on storage.objects;
create policy "task_files_storage_select" on storage.objects for select to authenticated
  using (bucket_id = 'task-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "task_files_storage_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'task-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "task_files_storage_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'task-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- A table that remembers which files belong to which task
create table if not exists public.task_files (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references public.tasks (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path       text not null,
  name       text not null,
  mime       text not null,
  size       integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_files_task_id_idx on public.task_files (task_id);

alter table public.task_files enable row level security;
drop policy if exists "task_files_select_own" on public.task_files;
drop policy if exists "task_files_insert_own" on public.task_files;
drop policy if exists "task_files_delete_own" on public.task_files;
create policy "task_files_select_own" on public.task_files for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "task_files_insert_own" on public.task_files for insert to authenticated
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = (select auth.uid())));
create policy "task_files_delete_own" on public.task_files for delete to authenticated
  using ((select auth.uid()) = user_id);


-- =====================================================================
-- NEW: monday-style board columns (status, due date, group)
-- =====================================================================
alter table public.tasks add column if not exists status text not null default 'todo'
  check (status in ('todo', 'working', 'stuck', 'done'));
alter table public.tasks add column if not exists due_date date;
alter table public.tasks add column if not exists group_name text not null default 'My tasks'
  check (char_length(group_name) between 1 and 40);

-- Give your existing tasks a matching status (only touches tasks still marked "todo")
update public.tasks set status = case when progress >= 100 then 'done' when progress > 0 then 'working' else 'todo' end
  where status = 'todo' and progress > 0;


-- =====================================================================
-- NEW: multiple boards and subitems
-- =====================================================================
alter table public.tasks add column if not exists board text not null default 'Main board'
  check (char_length(board) between 1 and 40);

create table if not exists public.subitems (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references public.tasks (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 120),
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists subitems_task_id_idx on public.subitems (task_id);

alter table public.subitems enable row level security;
drop policy if exists "subitems_select_own" on public.subitems;
drop policy if exists "subitems_insert_own" on public.subitems;
drop policy if exists "subitems_update_own" on public.subitems;
drop policy if exists "subitems_delete_own" on public.subitems;
create policy "subitems_select_own" on public.subitems for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "subitems_insert_own" on public.subitems for insert to authenticated
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = (select auth.uid())));
create policy "subitems_update_own" on public.subitems for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "subitems_delete_own" on public.subitems for delete to authenticated
  using ((select auth.uid()) = user_id);


-- =====================================================================
-- NEW (v3): completion dates, saved boards, profiles, profile photos
-- Run the whole file again, it is safe.
-- =====================================================================

-- When a task was finished (used by the Completed page, streaks and daily stats)
alter table public.tasks add column if not exists completed_at timestamptz;
update public.tasks set completed_at = created_at where status = 'done' and completed_at is null;

-- Boards are saved on their own, so an empty board stays until you delete it
create table if not exists public.boards (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.boards enable row level security;
drop policy if exists "boards_select_own" on public.boards;
drop policy if exists "boards_insert_own" on public.boards;
drop policy if exists "boards_delete_own" on public.boards;
create policy "boards_select_own" on public.boards for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "boards_insert_own" on public.boards for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "boards_delete_own" on public.boards for delete to authenticated
  using ((select auth.uid()) = user_id);
-- Keep the boards you already use
insert into public.boards (user_id, name)
  select distinct user_id, board from public.tasks
  on conflict (user_id, name) do nothing;

-- Profile: name, username, bio, photo, accent color, reminders
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text check (full_name is null or char_length(full_name) between 1 and 60),
  username      text check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  bio           text not null default '' check (char_length(bio) <= 200),
  avatar_path   text,
  accent        text check (accent is null or accent ~ '^#[0-9a-fA-F]{6}$'),
  notifications boolean not null default false,
  updated_at    timestamptz not null default now()
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Private bucket for profile photos: max 2 MB, images only, one folder per person
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars_storage_select" on storage.objects;
drop policy if exists "avatars_storage_insert" on storage.objects;
drop policy if exists "avatars_storage_delete" on storage.objects;
create policy "avatars_storage_select" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars_storage_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars_storage_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);


-- =====================================================================
-- NEW (v4): Contact us form on the website (visitors do not need an account)
-- Run the whole file again, it is safe.
-- Visitors can only SEND a message. Only you can read them:
-- Supabase > Table Editor > contact_messages
-- =====================================================================
create table if not exists public.contact_messages (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 80),
  email      text not null check (char_length(email) between 5 and 120 and email like '%_@_%._%'),
  message    text not null check (char_length(message) between 5 and 1000),
  created_at timestamptz not null default now()
);
alter table public.contact_messages enable row level security;
drop policy if exists "contact_insert_anyone" on public.contact_messages;
create policy "contact_insert_anyone" on public.contact_messages for insert to anon, authenticated
  with check (true);
