export class DomainError extends Error {
  readonly status: number = 400;
  readonly code: string = "bad_request";
}

export class ValidationError extends DomainError {
  override readonly status = 400;
  override readonly code = "invalid";
}

/** Also used for tasks the caller may not see, so existence of a private task never leaks. */
export class NotFoundError extends DomainError {
  override readonly status = 404;
  override readonly code = "not_found";
}

export class ForbiddenError extends DomainError {
  override readonly status = 403;
  override readonly code = "forbidden";
}

export class ConflictError extends DomainError {
  override readonly status = 409;
  override readonly code = "conflict";
  readonly current: unknown;
  constructor(message: string, current: unknown) {
    super(message);
    this.current = current;
  }
}
