import type { ToolContext } from "../types.js";

export type RuntimeTool<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: TArgs, context: ToolContext) => Promise<TResult>;
};
