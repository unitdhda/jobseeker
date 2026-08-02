-- Private, backend-only storage for encrypted mutable runtime state.
-- No storage.objects policies are created: only the service role may access it.
-- CV source files and generated applications must never be persisted here.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'jobseeker-private-state',
  'jobseeker-private-state',
  false,
  268435456,
  array['application/octet-stream']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
