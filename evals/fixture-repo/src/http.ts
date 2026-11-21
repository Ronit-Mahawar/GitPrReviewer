export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: any;
  userId?: string;
}

export interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

export type Next = () => void;
