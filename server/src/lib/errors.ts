/** Erro de validação mostrado no formulário (HTTP 400/409/422). */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code?: string,
  ) {
    super(message);
  }
}

/** Erros usados pelos conectores de plataforma para orientar a fila. */
export class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number, public kind: 'rate_limit' | 'transient' | 'quota' = 'transient') {
    super(message);
  }
}
export class AuthError extends Error {}
export class PermanentError extends Error {}
/** O pedido pode ter criado algo remotamente, mas não sabemos (timeout, conexão caiu). */
export class UnknownOutcomeError extends Error {}

/** O horário já não permite agendar/publicar com segurança: vira "Atrasado". */
export class LateError extends Error {}
/** O conector não consegue determinar o resultado: exige revisão manual. */
export class ManualReviewError extends Error {}
