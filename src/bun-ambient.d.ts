// Minimal ambient typings for pure Bun projects without external @types packages.

declare namespace NodeJS {
  type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
}

declare const process: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  cwd(): string;
  uptime(): number;
  memoryUsage?: () => { rss?: number; heapUsed?: number };
  exit(code?: number): never;
  exitCode?: number;
};

declare type BunSpawn = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin?: {
    write(data: string | Uint8Array): Promise<number>;
    end(): Promise<void>;
  };
  kill(): void;
};

declare interface BunFile extends Blob {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  stat(): Promise<{ size?: number; isDirectory(): boolean; isFile(): boolean; mtime?: Date }>;
  delete(): Promise<void>;
  readonly type: string;
  entries?(): Promise<Array<{ name: string }>>;
}

declare type BunServer = {
  stop(force?: boolean): void;
};

declare interface ServerWebSocket<T = unknown> {
  data: T;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

declare const Bun: {
  version: string;
  file(path: string): BunFile;
  write(path: string, data: string | Blob | ArrayBuffer | ArrayBufferView, options?: { append?: boolean }): Promise<number>;
  spawn(cmd: string[], options?: {
    cwd?: string;
    stdin?: "pipe" | "inherit" | "ignore";
    stdout?: "pipe" | "inherit" | "ignore";
    stderr?: "pipe" | "inherit" | "ignore";
  }): BunSpawn;
  spawnSync(cmd: string[], options?: { cwd?: string }): { exitCode: number; stdout?: Uint8Array; stderr?: Uint8Array };
  serve(options: {
    port: number;
    hostname?: string;
    fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | Promise<Response | void> | void;
    websocket?: {
      open?(ws: ServerWebSocket<unknown>): void;
      close?(ws: ServerWebSocket<unknown>): void;
      message?(ws: ServerWebSocket<unknown>, raw: string | Uint8Array): void | Promise<void>;
    };
  }): BunServer;
  stdin: {
    stream(): ReadableStream<Uint8Array>;
  };
  Glob: new (pattern: string) => {
    scan(options?: { cwd?: string; onlyFiles?: boolean; absolute?: boolean }): AsyncIterable<string>;
  };
};

declare module "bun:test" {
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: (value: unknown) => any;
  export const beforeAll: (fn: () => void | Promise<void>) => void;
  export const afterAll: (fn: () => void | Promise<void>) => void;
}

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean; strict?: boolean });
    exec(sql: string): void;
    query(sql: string): {
      get(...args: unknown[]): any;
      all(...args: unknown[]): any[];
      run(...args: unknown[]): { changes: number };
    };
    close(): void;
  }
}

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number };
  export function readFileSync(path: string, encoding: string): string;
}

declare module "path" {
  export function join(...paths: string[]): string;
}
