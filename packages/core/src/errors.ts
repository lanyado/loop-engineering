export class NotFoundError extends Error {
  constructor(entity: string, id: number | string) {
    super(`${entity} ${String(id)} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * A folder project already has an open (active or paused) session: two agents editing the same files
 * in place would collide, so a second one cannot start until the first ends.
 */
export class FolderBusyError extends ValidationError {
  constructor(
    readonly projectId: number,
    readonly sessionId: number,
  ) {
    super(`folder busy: project ${projectId} already has an open session (${sessionId}); end it first`);
    this.name = 'FolderBusyError';
  }
}

/** The message of a caught value, which need not be an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
