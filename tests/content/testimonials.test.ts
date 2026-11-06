import { describe, expect, it } from "vitest";
import { visibleTestimonials, type Testimonial } from "../../content/testimonials";

const base: Testimonial[] = [
  { quote: "Hidup saya berubah.", name: "Maria", photo: "/maria.jpg", consent: true },
  { quote: "Relasi keluarga dipulihkan.", name: "Yohanes", photo: "/yo.jpg", consent: false },
  { quote: "Tanpa foto.", name: "Agnes", consent: true },
];

describe("visibleTestimonials", () => {
  it("drops name and photo without consent but keeps the quote", () => {
    const out = visibleTestimonials(base);
    expect(out[1]).toEqual({ quote: "Relasi keluarga dipulihkan." });
    expect(Object.keys(out[1])).toEqual(["quote"]);
    expect(JSON.stringify(out[1])).not.toMatch(/Yohanes|yo\.jpg/);
  });
  it("keeps name and photo with consent", () => {
    expect(visibleTestimonials(base)[0]).toEqual({ quote: "Hidup saya berubah.", name: "Maria", photo: "/maria.jpg" });
    expect(visibleTestimonials(base)[2]).toEqual({ quote: "Tanpa foto.", name: "Agnes" });
  });
  it("shipped testimonials all default to no consent", async () => {
    const { testimonials } = await import("../../content/testimonials");
    expect(testimonials.every((t) => t.consent === false)).toBe(true);
  });
});
