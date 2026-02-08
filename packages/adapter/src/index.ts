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

export type DataReadOptions = {
  id?: Id;
  filter?: Record<string, unknown>;
  limit?: number;
};

export type StorageUploadOptions = {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
};

export interface BackendAuth {
  signIn(params: { email: string; password: string }): Promise<AuthSession>;
  signOut(): Promise<void>;
  getUser(): Promise<AuthUser | null>;
}

export interface BackendData {
  create<T extends DataRecord>(entity: string, data: T): Promise<T>;
  read<T extends DataRecord>(entity: string, options?: DataReadOptions): Promise<T | T[] | null>;
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
}

export interface Backend {
  auth: BackendAuth;
  data: BackendData;
  storage: BackendStorage;
}
