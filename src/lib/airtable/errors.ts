/** Airtable error kinds (no server-only deps so mocks of the client never hide them). */
/** Transient = 429 / 5xx / network / local overload: retry later (503), never "not found". */
export class AirtableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly transient: boolean,
    public readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "AirtableError";
  }
}

export const isTransientAirtableError = (e: unknown): e is AirtableError => e instanceof AirtableError && e.transient;
/** True only for a genuine Airtable 404 (or 422 for a malformed id): the record does not exist. */
export const isAirtableNotFound = (e: unknown): boolean =>
  e instanceof AirtableError ? !e.transient && (e.status === 404 || e.status === 422) : e instanceof Error && /HTTP (404|422)\b/.test(e.message);

