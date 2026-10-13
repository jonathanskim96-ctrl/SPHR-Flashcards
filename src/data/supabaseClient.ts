// The Supabase client for the app. Only the project URL and the publishable key are
// client-side (repo variables, CLAUDE.md §2). Email + password sign-in with PKCE.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function createAppClient(
  url: string | undefined = import.meta.env.VITE_SUPABASE_URL as string | undefined,
  key: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined,
): SupabaseClient {
  if (!url || !key)
    throw new Error('The app is not configured: the Supabase URL or key is missing.');
  return createClient(url, key, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
