export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
  idemKey?: string;
};

export type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

export type EventFrame = {
  type: "event";
  event: string;
  payload: unknown;
  seq: number;
  sessionId?: string;
};

export type ConnectFrame = {
  type: "connect";
  auth?: { token?: string };
  client?: string;
};

export type Config = {
  gateway: {
    host: string;
    port: number;
    token?: string;
    allowExternal?: boolean;
  };
  model: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxToolRounds: number;
  };
  tools: {
    profile: "minimal" | "coding" | "full";
    allow: string[];
    deny: string[];
    webSearch?: {
      provider?: string;
      providers?: string[];
      categories?: string[];
      endpoint?: string;
      apiKey?: string;
      timeoutMs?: number;
      customScript?: string;
    };
  };
  sessions: {
    dbPath: string;
    eventsPath: string;
    workspace: string;
  };
  storage?: {
    baseDir: string;
    skillsDir: string;
    agentsDir: string;
    channelsDir: string;
  };
  security: {
    workspaceOnly: boolean;
  };
  ui: {
    brandName: string;
  };
};

export type Session = { id: string; sessionKey: string; createdAt: string; updatedAt: string };
export type Message = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};


