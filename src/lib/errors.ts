export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function errorBody(err: ApiError): Record<string, unknown> {
  return { error: { code: err.code, message: err.message, ...(err.details ?? {}) } };
}
