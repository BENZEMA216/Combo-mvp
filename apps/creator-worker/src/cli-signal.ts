import { CreatorWorkerLocalAlphaError } from './local-alpha-contract.js';

/** Internal process-adapter seam; intentionally absent from the package root export. */
export function localSignalExitCode(
  signal: NodeJS.Signals | undefined,
  error: unknown,
): number | undefined {
  if (signal === undefined || !isCancellationError(error)) return undefined;
  return signal === 'SIGINT' ? 130 : 143;
}

function isCancellationError(error: unknown): boolean {
  if (
    error instanceof CreatorWorkerLocalAlphaError &&
    error.code === 'LOCAL_ALPHA_TURN_CANCELLED'
  ) {
    return true;
  }
  if (typeof error !== 'object' || error === null) return false;
  return (
    ('name' in error && error.name === 'AbortError') ||
    ('code' in error && error.code === 'ABORT_ERR')
  );
}
