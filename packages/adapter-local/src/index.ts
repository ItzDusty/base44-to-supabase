import type { Backend } from '@base44-to-supabase/adapter';
import { createSupabaseBackend } from '@base44-to-supabase/adapter-supabase';

export type LocalSupabaseBackendOptions = {
  url?: string;
  anonKey: string;
};

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:54321';

export function createLocalSupabaseBackend(options: LocalSupabaseBackendOptions): Backend {
  return createSupabaseBackend({
    url: options.url ?? DEFAULT_LOCAL_URL,
    anonKey: options.anonKey,
  });
}

export function createLocalSupabaseBackendFromEnv(env: NodeJS.ProcessEnv = process.env): Backend {
  const url = env.SUPABASE_URL ?? env.SUPABASE_LOCAL_URL ?? DEFAULT_LOCAL_URL;
  const anonKey = env.SUPABASE_ANON_KEY ?? env.SUPABASE_LOCAL_ANON_KEY;
  if (!anonKey) {
    throw new Error('Missing SUPABASE_ANON_KEY (or SUPABASE_LOCAL_ANON_KEY) in environment');
  }
  return createLocalSupabaseBackend({ url, anonKey });
}
