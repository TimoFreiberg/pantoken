import { spawnAsync as defaultSpawnAsync, type SpawnOptions, type SpawnResult } from "./node-compat.js";

/** Options accepted by the captured release-readiness command executor. */
export interface ReleaseCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** A subprocess implementation used by release-readiness command executors. */
export type ReleaseCommandSpawner = (
  command: string[],
  options?: SpawnOptions,
) => Promise<SpawnResult>;

/** Result-returning executor shared by ordinary readiness commands and Buck2. */
export type ReleaseCommandExecutor = (
  command: string[],
  options: ReleaseCommandOptions,
) => Promise<SpawnResult>;

export interface ReleaseCommandDependencies {
  spawnAsync?: ReleaseCommandSpawner;
  now?: () => number;
  log?: (message: string) => void;
}

function formatCommand(command: string[]): string {
  return command
    .map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one release-readiness subprocess with concise status logging and complete
 * output capture. Successful child output is deliberately not logged; failure
 * diagnostics are included in the thrown error after the failure status line.
 */
export async function runCapturedReleaseCommand(
  command: string[],
  options: ReleaseCommandOptions = {},
  dependencies: ReleaseCommandDependencies = {},
): Promise<SpawnResult> {
  const commandText = formatCommand(command);
  const now = dependencies.now ?? (() => performance.now());
  const log = dependencies.log ?? console.log;
  const spawn = dependencies.spawnAsync ?? defaultSpawnAsync;
  const started = now();

  log(`release-readiness: start ${commandText}`);
  let result: SpawnResult;
  try {
    result = await spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // A rejected spawner has no child result and therefore no streams to
    // report; add its original start error to a separate failure status.
    const duration = formatDuration(Math.max(0, now() - started));
    const startError = errorText(error);
    log(`release-readiness: stop ${commandText} (failure, start error, ${duration})`);
    const wrapped = new Error(
      `${commandText} failed to start after ${duration}: ${startError}`,
    );
    try {
      Object.defineProperty(wrapped, "cause", { value: error, enumerable: false });
    } catch {
      // Older runtimes may not allow defining Error.cause; the diagnostic above
      // still retains the original text in that case.
    }
    throw wrapped;
  }

  const duration = formatDuration(Math.max(0, now() - started));
  const code = result.code ?? 1;
  if (code === 0) {
    log(`release-readiness: stop ${commandText} (success, ${duration})`);
    return result;
  }

  log(`release-readiness: stop ${commandText} (failure, exit code ${result.code}, ${duration})`);
  throw new Error(
    `${commandText} failed with exit code ${result.code} after ${duration}\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}`,
  );
}

/**
 * Adapter preserving the existing readiness CommandRunner Promise<void>
 * contract while delegating capture, timing, and diagnostics to the shared
 * result-returning executor.
 */
export async function runReleaseCommand(
  command: string[],
  options: { cwd: string; env?: Record<string, string> },
  executor: ReleaseCommandExecutor = runCapturedReleaseCommand,
): Promise<void> {
  await executor(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
}

export type { SpawnResult };
