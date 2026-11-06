/** The single application error type; the API error handler maps it to an HTTP response. */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 423 | 429 | 500 | 503,
    public publicMessage: string,
    public details?: unknown,
  ) {
    super(publicMessage);
  }
}
export const notFound = (what = "Resource") => new AppError("not_found", 404, `${what} not found`);
export const forbidden = (msg = "Forbidden") => new AppError("forbidden", 403, msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(code, 409, msg, details);
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(code, 400, msg, details);
