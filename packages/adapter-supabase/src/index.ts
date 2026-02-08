import type {
  Backend,
  BackendAuth,
  BackendData,
  BackendStorage,
  DataReadOptions,
  Id,
} from '@base44-to-supabase/adapter';
import { createClient } from '@supabase/supabase-js';

export type SupabaseBackendOptions = {
  url: string;
  anonKey: string;
};

export function createSupabaseBackend(options: SupabaseBackendOptions): Backend {
  const supabase = createClient(options.url, options.anonKey);

  const auth: BackendAuth = {
    async signIn({ email, password }) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return {
        accessToken: data.session?.access_token,
        refreshToken: data.session?.refresh_token,
        expiresAt: data.session?.expires_at,
        user: data.user ?? undefined,
      };
    },
    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    async getUser() {
      const { data, error } = await supabase.auth.getUser();
      if (error) throw error;
      return data.user ?? null;
    },
  };

  const dataApi: BackendData = {
    async create(entity, data) {
      const { data: rows, error } = await supabase.from(entity).insert(data).select().limit(1);
      if (error) throw error;
      return (rows?.[0] ?? data) as any;
    },
    async read(entity, options?: DataReadOptions) {
      let query = supabase.from(entity).select('*');
      if (options?.id) query = query.eq('id', options.id).limit(1);
      if (options?.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          query = query.eq(key, value as any);
        }
      }
      if (options?.limit) query = query.limit(options.limit);

      const { data, error } = await query;
      if (error) throw error;
      if (options?.id) return (data?.[0] ?? null) as any;
      return (data ?? []) as any;
    },
    async update(entity, id: Id, data) {
      const { data: rows, error } = await supabase
        .from(entity)
        .update(data)
        .eq('id', id)
        .select()
        .limit(1);
      if (error) throw error;
      return (rows?.[0] ?? { id, ...data }) as any;
    },
    async delete(entity, id: Id) {
      const { error } = await supabase.from(entity).delete().eq('id', id);
      if (error) throw error;
    },
  };

  const storage: BackendStorage = {
    async upload(bucket, path, file, options) {
      const { error } = await supabase.storage.from(bucket).upload(path, file as any, {
        contentType: options?.contentType,
        cacheControl: options?.cacheControl,
        upsert: options?.upsert,
      });
      if (error) throw error;
      return { path };
    },
    async download(bucket, path) {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw error;
      const arrayBuffer = await data.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    },
  };

  return { auth, data: dataApi, storage };
}

export function createSupabaseBackendFromEnv(env: NodeJS.ProcessEnv = process.env): Backend {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment');
  }
  return createSupabaseBackend({ url, anonKey });
}
