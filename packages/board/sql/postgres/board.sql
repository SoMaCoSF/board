-- board's tables, which live next to A2's. schema.sql holds both: apply that.

create table if not exists board_positions (
  consumer text primary key,
  log_index bigint not null
);
--> statement-breakpoint
create table if not exists board_messages (
  id bigint primary key,
  event_id text not null unique,
  channel text not null,
  re bigint,
  by_actor text not null,
  by_principal text not null,
  by_profile text,
  from_key text,
  no_sync boolean not null,
  text_lower text not null,
  deleted boolean not null,
  created_at bigint not null,
  replies integer not null default 0,
  at bigint,
  data text not null
);
--> statement-breakpoint
create index if not exists board_messages_channel on board_messages (channel, id);
--> statement-breakpoint
create index if not exists board_messages_re on board_messages (re, id);
--> statement-breakpoint
create index if not exists board_messages_by_actor on board_messages (by_actor, id);
--> statement-breakpoint
create index if not exists board_messages_by_principal on board_messages (by_principal, id);
--> statement-breakpoint
create index if not exists board_threads_at on board_messages (at) where re is null;
--> statement-breakpoint
create index if not exists board_threads_channel on board_messages (channel, at) where re is null;
--> statement-breakpoint
create table if not exists board_versions (
  log_index bigint primary key,
  message_id bigint not null,
  data text not null
);
--> statement-breakpoint
create index if not exists board_versions_message on board_versions (message_id, log_index);
--> statement-breakpoint
create table if not exists board_terms (
  message_id bigint not null,
  term text not null,
  value text not null,
  primary key (message_id, term, value)
);
--> statement-breakpoint
create index if not exists board_terms_term on board_terms (term, value, message_id);
--> statement-breakpoint
create table if not exists board_sync_threads (
  thread text primary key,
  data text not null
);
--> statement-breakpoint
create table if not exists board_external_threads (
  external text primary key,
  thread text not null
);
--> statement-breakpoint
create table if not exists board_copies (
  message_id bigint not null,
  target text not null,
  data text not null,
  primary key (message_id, target)
);
--> statement-breakpoint
create table if not exists board_external_messages (
  key text primary key,
  message_id bigint not null
);
--> statement-breakpoint
drop index if exists board_messages_recent;
--> statement-breakpoint
drop function if exists board_apply(text, bigint, boolean, jsonb, jsonb, jsonb);
--> statement-breakpoint
create or replace function board_apply(
  apply_consumer text,
  apply_index bigint,
  apply_next boolean,
  apply_message jsonb,
  apply_terms jsonb,
  apply_summary jsonb,
  apply_sync jsonb
) returns boolean language plpgsql as $$
begin
  if apply_next then
    update board_positions set log_index = apply_index
      where consumer = apply_consumer and log_index = apply_index - 1;
  else
    insert into board_positions (consumer, log_index) values (apply_consumer, apply_index)
      on conflict (consumer) do update set log_index = excluded.log_index
      where board_positions.log_index < excluded.log_index;
  end if;
  if not found then
    return false;
  end if;
  if apply_message is not null then
    if (apply_message->>'created')::boolean then
      insert into board_messages
        (id, event_id, channel, re, by_actor, by_principal, by_profile, from_key, no_sync, text_lower, deleted, created_at, data)
        values (
          (apply_message->>'id')::bigint, apply_message->>'event_id', apply_message->>'channel', (apply_message->>'re')::bigint,
          apply_message->>'by_actor', apply_message->>'by_principal', apply_message->>'by_profile', apply_message->>'from_key',
          (apply_message->>'no_sync')::boolean, apply_message->>'text_lower', (apply_message->>'deleted')::boolean,
          (apply_message->>'created_at')::bigint, apply_message->>'data');
    else
      update board_messages
        set text_lower = apply_message->>'text_lower', deleted = (apply_message->>'deleted')::boolean, data = apply_message->>'data'
        where id = (apply_message->>'id')::bigint;
    end if;
    insert into board_versions (log_index, message_id, data)
      values (apply_index, (apply_message->>'id')::bigint, apply_message->>'data');
    if apply_terms is not null then
      delete from board_terms where message_id = (apply_message->>'id')::bigint;
      insert into board_terms (message_id, term, value)
        select (apply_message->>'id')::bigint, term->>0, term->>1 from jsonb_array_elements(apply_terms) as term;
    end if;
  end if;
  if apply_summary is not null then
    update board_messages set replies = (apply_summary->>'replies')::int, at = (apply_summary->>'at')::bigint
      where id = (apply_summary->>'root')::bigint;
  end if;
  if apply_sync is not null then
    if jsonb_typeof(apply_sync->'thread') = 'object' then
      insert into board_sync_threads (thread, data) values (apply_sync->'thread'->>'key', apply_sync->'thread'->>'data')
        on conflict (thread) do update set data = excluded.data;
    end if;
    insert into board_external_threads (external, thread)
      select entry->>0, entry->>1 from jsonb_array_elements(apply_sync->'external_threads') as entry
      on conflict (external) do update set thread = excluded.thread;
    insert into board_copies (message_id, target, data)
      select (entry->>0)::bigint, entry->>1, entry->>2 from jsonb_array_elements(apply_sync->'copies') as entry
      on conflict (message_id, target) do update set data = excluded.data;
    insert into board_external_messages (key, message_id)
      select entry->>0, (entry->>1)::bigint from jsonb_array_elements(apply_sync->'external_messages') as entry
      on conflict (key) do update set message_id = excluded.message_id;
  end if;
  return true;
end
$$;
