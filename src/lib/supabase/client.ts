import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function createClient() {
  if (_client) return _client;
  _client = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "qmais-session",
      },
    }
  );
  return _client;
}
