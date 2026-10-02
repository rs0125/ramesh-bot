export const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_ITEMS = 8;
export type MediaKind = 'audio' | 'image' | 'document';
export type MediaExtraction = ({ text: string; truncated?: boolean } | { failure: string }) & {
  kind?: MediaKind;
};
export interface MediaUpload {
  bytes: Buffer;
  mime: string;
  name: string;
}
export interface MediaRecord {
  id: string;
  owner: string;
  source: string;
  createdAt: Date;
  expiresAt: Date;
  state: 'pending' | 'processing' | 'ready' | 'failed';
  upload?: MediaUpload;
  text?: string;
  failure?: string;
  kind?: MediaKind;
  truncated?: boolean;
  token?: string;
}
export interface MediaStore {
  put(owner: string, source: string, upload: MediaUpload, receivedAt?: Date): Promise<string>;
  get(owner: string, ids?: string[]): Promise<MediaRecord[]>;
  /** Exact retained-source lookup; unlike recent-context reads, this has no last-eight window. */
  findSource?(owner: string, source: string): Promise<string | undefined>;
  claim(owner: string, id: string): Promise<MediaRecord | null>;
  finish(owner: string, id: string, token: string, result: MediaExtraction): Promise<void>;
  clear(owner: string): Promise<void>;
  clean(): Promise<void>;
}
export interface MediaProcessor {
  extract(upload: MediaUpload, signal: AbortSignal): Promise<string>;
}
