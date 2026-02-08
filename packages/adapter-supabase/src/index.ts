import type {
  Backend,
  BackendAuth,
  BackendData,
  BackendRpc,
  BackendStorage,
  DataFilter,
  DataReadOptions,
  DataOrderBy,
  Id,
} from '@base44-to-supabase/adapter';
import { createClient } from '@supabase/supabase-js';

export type SupabaseBackendOptions = {
  url: string;
  anonKey: string;
};

export function createSupabaseBackend(options: SupabaseBackendOptions): Backend {
  const supabase = createClient(options.url, options.anonKey);

  function toAuthSession(session: any): any {
    if (!session) return null;
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
      user: session.user,
    };
  }

  function normalizeSelect(select?: DataReadOptions['select']): string {
    if (!select) return '*';
    if (Array.isArray(select)) return select.join(',');
    return select;
  }

  function normalizeOrderBy(orderBy?: DataReadOptions['orderBy']): DataOrderBy[] {
    if (!orderBy) return [];
    return Array.isArray(orderBy) ? orderBy : [orderBy];
  }

  function applyFilterOp(query: any, filter: DataFilter): any {
    const { field, op, value } = filter;
    switch (op) {
      case 'eq':
        return query.eq(field, value as any);
      case 'neq':
        return query.neq(field, value as any);
      case 'gt':
        return query.gt(field, value as any);
      case 'gte':
        return query.gte(field, value as any);
      case 'lt':
        return query.lt(field, value as any);
      case 'lte':
        return query.lte(field, value as any);
      case 'like':
        return query.like(field, value as any);
      case 'ilike':
        return query.ilike(field, value as any);
      case 'in':
        return query.in(field, value as any);
      case 'contains':
        return query.contains(field, value as any);
      case 'containedBy':
        return query.containedBy(field, value as any);
      case 'is':
        return query.is(field, value as any);
      default:
        return query;
    }
  }

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
    async signUp({ email, password }) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      return {
        accessToken: data.session?.access_token,
        refreshToken: data.session?.refresh_token,
        expiresAt: data.session?.expires_at,
        user: data.user ?? undefined,
      };
    },
    async resetPasswordForEmail(email, options) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: options?.redirectTo,
      });
      if (error) throw error;
    },
    async updatePassword(newPassword) {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
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
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return toAuthSession(data.session);
    },
    onAuthStateChange(callback) {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        callback(event, toAuthSession(session));
      });
      return {
        unsubscribe: () => {
          data.subscription.unsubscribe();
        },
      };
    },
  };

  const dataApi: BackendData = {
    async create(entity, data) {
      const { data: rows, error } = await supabase.from(entity).insert(data).select().limit(1);
      if (error) throw error;
      return (rows?.[0] ?? data) as any;
    },
    async read(entity, options?: DataReadOptions) {
      let query = supabase.from(entity).select(normalizeSelect(options?.select));
      if (options?.id) query = query.eq('id', options.id).limit(1);
      if (options?.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          query = query.eq(key, value as any);
        }
      }
      if (options?.filters) {
        for (const f of options.filters) {
          query = applyFilterOp(query, f);
        }
      }

      for (const o of normalizeOrderBy(options?.orderBy)) {
        query = query.order(o.field, { ascending: o.ascending ?? true });
      }

      if (options?.limit) query = query.limit(options.limit);
      if (typeof options?.offset === 'number')
        query = query.range(options.offset, (options.offset ?? 0) + (options?.limit ?? 1000) - 1);

      const { data, error } = await query;
      if (error) throw error;
      if (options?.id) return (data?.[0] ?? null) as any;
      return (data ?? []) as any;
    },
    async upsert(entity, data, options) {
      const { data: rows, error } = await supabase
        .from(entity)
        .upsert(data as any, {
          onConflict: options?.onConflict,
        })
        .select();
      if (error) throw error;
      if (Array.isArray(data)) return (rows ?? []) as any;
      return (rows?.[0] ?? data) as any;
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
    async remove(bucket, paths) {
      const list = Array.isArray(paths) ? paths : [paths];
      const { error } = await supabase.storage.from(bucket).remove(list);
      if (error) throw error;
    },
    async list(bucket, path, options) {
      const { data, error } = await supabase.storage.from(bucket).list(path, {
        limit: options?.limit,
        offset: options?.offset,
        search: options?.search,
      });
      if (error) throw error;
      return (data ?? []) as any;
    },
    async createSignedUrl(bucket, path, expiresInSeconds) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error('Supabase did not return a signedUrl');
      return { signedUrl: data.signedUrl };
    },
    getPublicUrl(bucket, path) {
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      return { publicUrl: data.publicUrl };
    },
  };

  const rpc: BackendRpc = {
    async call(fn, params) {
      const { data, error } = await supabase.rpc(fn, params as any);
      if (error) throw error;
      return data as any;
    },
  };

  return { auth, data: dataApi, storage, rpc };
}

export function createSupabaseBackendFromEnv(env: NodeJS.ProcessEnv = process.env): Backend {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment');
  }
  return createSupabaseBackend({ url, anonKey });
}
