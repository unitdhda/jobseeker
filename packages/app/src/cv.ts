import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import type { CvExtractionWarning, ExtractedCvDocument } from '@jobseeker/cv/extract';

export interface CvParserCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface CvParserOptions {
  readonly command: CvParserCommand;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

export interface CvImportPreview {
  readonly filename: string;
  readonly sha256: string;
  readonly characterCount: number;
  readonly blockCount: number;
  readonly excerpt: string;
  readonly warnings: readonly CvExtractionWarning[];
}

export interface ParsedCvUpload {
  readonly extraction: ExtractedCvDocument;
  readonly preview: CvImportPreview;
}

export interface CvParser {
  parse(filename: string, mediaType: string | undefined, bytes: Uint8Array): Promise<ParsedCvUpload>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

export class CvParserProcessError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'CvParserProcessError';
    this.code = code;
  }
}

const maximumIpcBytes = 1024 * 1024;

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid CV parser ${name}: expected a positive safe integer, received ${value}.`);
  }
}

function parserProcess(
  command: CvParserCommand,
  timeoutMs: number,
  request: unknown,
): Promise<ExtractedCvDocument> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      env: { ...(command.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;

    // Every completion path funnels through settle, which clears timeout and force-kills a still-live parser.
    const timer = setTimeout(() => {
      settle(new CvParserProcessError(`CV parser exceeded ${timeoutMs} ms timeout.`, 'CV_PARSER_TIMEOUT'));
    }, timeoutMs);
    const settle = (error?: Error, extraction?: ExtractedCvDocument): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(extraction!);
    };

    child.on('error', (error) => settle(new CvParserProcessError(`CV parser process failed to start: ${error.message}.`)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maximumIpcBytes) settle(new CvParserProcessError('CV parser stdout exceeded 1 MiB.', 'CV_PARSER_OUTPUT_LIMIT'));
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maximumIpcBytes) settle(new CvParserProcessError('CV parser stderr exceeded 1 MiB.', 'CV_PARSER_OUTPUT_LIMIT'));
    });
    child.on('close', () => {
      if (settled) return;
      try {
        const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
        if (lines.length !== 1) throw new CvParserProcessError('CV parser returned an invalid result count.');
        const response = JSON.parse(lines[0]!) as {
          ok?: boolean;
          extraction?: ExtractedCvDocument;
          error?: { message?: string; code?: string };
        };
        if (!response.ok || !response.extraction) {
          throw new CvParserProcessError(
            response.error?.message?.slice(0, 1_000) || 'CV parser returned an error.',
            response.error?.code,
          );
        }
        settle(undefined, response.extraction);
      } catch (error) {
        settle(error instanceof Error ? error : new CvParserProcessError('CV parser returned invalid JSON.'));
      }
    });

    child.stdin.on('error', (error) => settle(new CvParserProcessError(`CV parser IPC write failed: ${error.message}.`)));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

/** Creates a bounded process adapter; extraction never runs in the long-lived application process. */
export function createCvParser(options: CvParserOptions): CvParser {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = options.concurrency ?? 2;
  assertPositiveSafeInteger(timeoutMs, 'timeout');
  assertPositiveSafeInteger(concurrency, 'concurrency');
  if (!options.command.executable) throw new TypeError('Invalid CV parser command: executable is required.');
  const limit = pLimit(concurrency);

  return Object.freeze({
    get activeCount(): number { return limit.activeCount; },
    get pendingCount(): number { return limit.pendingCount; },
    parse(filename: string, mediaType: string | undefined, bytes: Uint8Array): Promise<ParsedCvUpload> {
      if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError('Invalid CV upload bytes: expected Uint8Array.'));
      return limit(async () => {
        const extraction = await parserProcess(options.command, timeoutMs, {
          filename,
          ...(mediaType === undefined ? {} : { mediaType }),
          bytesBase64: Buffer.from(bytes).toString('base64'),
        });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return Object.freeze({
          extraction,
          preview: Object.freeze({
            filename,
            sha256,
            characterCount: extraction.text.length,
            blockCount: extraction.document.blocks.length,
            excerpt: extraction.text.slice(0, 700),
            warnings: Object.freeze([...(extraction.document.warnings ?? [])]),
          }),
        });
      });
    },
  });
}

/** Production Node command with a bounded heap and filesystem reads restricted to the bundle/dependency roots. */
export function nodeCvParserCommand(
  workerPath: string,
  readableRoots: readonly string[],
  env: Readonly<Record<string, string>> = {},
): CvParserCommand {
  if (!workerPath || readableRoots.length === 0) {
    throw new TypeError('Invalid Node CV parser command: worker path and readable roots are required.');
  }
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      '--max-old-space-size=256',
      '--permission',
      `--allow-fs-read=${readableRoots.join(',')}`,
      workerPath,
    ]),
    env: Object.freeze({ ...env }),
  });
}

/** Source checkout command is explicit so production never accidentally launches Bun without Node permissions. */
export function bunCvParserCommand(
  bunExecutable: string,
  workerPath: string,
  env: Readonly<Record<string, string>> = {},
): CvParserCommand {
  if (!bunExecutable || !workerPath) throw new TypeError('Invalid Bun CV parser command.');
  return Object.freeze({ executable: bunExecutable, args: Object.freeze(['run', workerPath]), env: Object.freeze({ ...env }) });
}
