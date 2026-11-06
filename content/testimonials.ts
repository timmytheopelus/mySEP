export type Testimonial = { quote: string; name: string; photo?: string; consent: boolean };
export type VisibleTestimonial = { quote: string; name?: string; photo?: string };

/**
 * Kutipan alumni. `consent` WAJIB false sampai alumni yang bersangkutan memberi izin tertulis; selama itu
 * hanya kutipan yang tampil. Daftar sengaja kosong: buku sumber belum tersedia, jangan mengarang kesaksian.
 * Tambahkan kutipan asli di sini; bagian kesaksian di halaman otomatis muncul.
 */
export const testimonials: Testimonial[] = [];

export function visibleTestimonials(items: Testimonial[]): VisibleTestimonial[] {
  return items.map((t) =>
    t.consent
      ? { quote: t.quote, name: t.name, ...(t.photo ? { photo: t.photo } : {}) }
      : { quote: t.quote },
  );
}
