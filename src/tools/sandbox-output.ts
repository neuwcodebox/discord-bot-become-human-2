import { StringDecoder } from "node:string_decoder";

export type SandboxResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputLimitBytes: number;
};

/** Keeps draining the pipe after the limit, without retaining further output. */
export class SandboxOutput {
  private readonly chunks: string[] = [];
  private retainedBytes = 0;
  private limitReached = false;
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly limitBytes: number) {}

  get text(): string {
    return this.chunks.join("");
  }

  get truncated(): boolean {
    return this.limitReached;
  }

  append(chunk: unknown): void {
    if (this.truncated) return;
    if (!Buffer.isBuffer(chunk)) throw new Error("Sandbox output must be a byte stream.");
    this.addText(this.decoder.write(chunk));
  }

  finish(): void {
    if (!this.truncated) this.addText(this.decoder.end());
  }

  private addText(text: string): void {
    const bytes = Buffer.from(text);
    if (bytes.length === 0) return;
    const available = this.limitBytes - this.retainedBytes;
    if (bytes.length <= available) {
      this.chunks.push(text);
      this.retainedBytes += bytes.length;
      return;
    }
    this.limitReached = true;
    let end = available;
    // Do not retain an incomplete UTF-8 code point at the output boundary.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    this.chunks.push(bytes.subarray(0, end).toString("utf8"));
    this.retainedBytes += end;
  }
}
