export type Id = string;

export type AuthUser = {
  id: string;
  email?: string;
};

export type AuthSession = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  user?: AuthUser;
};

export type DataRecord = Record<string, unknown> & { id?: Id };

export type DataOrderBy = {
  field: string;
  ascending?: boolean;
};

export type DataFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'contains'
  | 'containedBy'
  | 'is';

export type DataFilter = {
  field: string;
  op: DataFilterOp;
  value: unknown;
};

export type DataReadOptions = {
  id?: Id;
  filter?: Record<string, unknown>;
  filters?: DataFilter[];
  select?: string | string[];
  orderBy?: DataOrderBy | DataOrderBy[];
  limit?: number;
  offset?: number;
};

export type StorageUploadOptions = {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
};

export interface BackendAuth {
  signIn(params: { email: string; password: string }): Promise<AuthSession>;
  signUp(params: { email: string; password: string }): Promise<AuthSession>;
  resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  getUser(): Promise<AuthUser | null>;
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): {
    unsubscribe: () => void;
  };
}

export interface BackendData {
  create<T extends DataRecord>(entity: string, data: T): Promise<T>;
  read<T extends DataRecord>(entity: string, options?: DataReadOptions): Promise<T | T[] | null>;
  upsert<T extends DataRecord>(
    entity: string,
    data: T | T[],
    options?: { onConflict?: string },
  ): Promise<T | T[]>;
  update<T extends DataRecord>(entity: string, id: Id, data: Partial<T>): Promise<T>;
  delete(entity: string, id: Id): Promise<void>;
}

export interface BackendStorage {
  upload(
    bucket: string,
    path: string,
    file: Uint8Array | ArrayBuffer | Blob,
    options?: StorageUploadOptions,
  ): Promise<{ path: string }>;
  download(bucket: string, path: string): Promise<Uint8Array>;
  remove(bucket: string, paths: string | string[]): Promise<void>;
  list(
    bucket: string,
    path?: string,
    options?: { limit?: number; offset?: number; search?: string },
  ): Promise<Array<Record<string, unknown>>>;
  createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<{ signedUrl: string }>;
  getPublicUrl(bucket: string, path: string): { publicUrl: string };
}

export interface BackendRpc {
  call<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T>;
}

export interface Backend {
  auth: BackendAuth;
  data: BackendData;
  storage: BackendStorage;
  rpc: BackendRpc;
}
