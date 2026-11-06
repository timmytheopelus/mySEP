export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    message?: string,
  ) {
    super(message ?? DEFAULT[status]);
    this.name = "HttpError";
  }
}
const DEFAULT = {
  400: "Permintaan tidak valid",
  401: "Belum masuk",
  403: "Tidak diizinkan",
  404: "Tidak ditemukan",
  409: "Konflik data",
  422: "Data tidak valid",
  429: "Terlalu banyak percobaan",
  503: "Layanan sementara tidak tersedia",
} as const;
