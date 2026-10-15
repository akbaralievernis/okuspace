export const appErrorCodes = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export type FieldErrors = Record<string, string[]>;

/** Ожидаемая ошибка домена. `message` безопасно показывать пользователю. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors: FieldErrors | undefined;

  constructor(code: AppErrorCode, message: string, options?: { fieldErrors?: FieldErrors; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
  }
}

/** То, что разрешено отдать клиенту. Никаких stack trace, SQL и внутренних сообщений. */
export interface PublicError {
  code: AppErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
  requestId?: string;
}

const GENERIC_MESSAGE = 'Произошла ошибка. Попробуйте ещё раз.';

export function toPublicError(error: unknown, requestId?: string): PublicError {
  const base: PublicError =
    error instanceof AppError
      ? {
          code: error.code,
          // Для INTERNAL сообщение может содержать детали реализации — заменяем.
          message: error.code === 'INTERNAL' ? GENERIC_MESSAGE : error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        }
      : { code: 'INTERNAL', message: GENERIC_MESSAGE };
  return requestId ? { ...base, requestId } : base;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: PublicError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (error: PublicError): Result<never> => ({ ok: false, error });
