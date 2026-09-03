type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(input: unknown): unknown;
};

interface Document {
  readonly modelContext?: {
    registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
  };
}
declare const __SOURCE_COMMIT__: string;

declare module '*?worker' {
  const WorkerFactory: new (options?: WorkerOptions) => Worker;
  export default WorkerFactory;
}
