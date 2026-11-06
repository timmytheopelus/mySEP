export class HttpError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    message?: string,
  ) {
    super(message ?? DEFAULT[status]);
    this.name = "HttpError";
  }
}
const DEFAULT = { 401: "Belum masuk", 403: "Tidak diizinkan", 404: "Tidak ditemukan" } as const;
