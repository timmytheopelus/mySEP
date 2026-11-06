import { describe, expect, it } from "vitest";
import { embedUrl, parseYoutubeId } from "@/lib/pewarta/youtube";

const ID = "dQw4w9WgXcQ";
describe("parseYoutubeId", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=10s`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abc`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
  ])("accepts %s", (u) => expect(parseYoutubeId(u)).toBe(ID));

  it.each([
    ["https://evil.com/watch?v=abcdefghijk"],
    ["https://evil.com/?v=dQw4w9WgXcQ"],
    ["https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ"],
    ["https://evil.io/youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://youtube.com@evil.io/watch?v=dQw4w9WgXcQ"],
    ["https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ"],
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["//evil.io/watch?v=dQw4w9WgXcQ"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>1</script>"],
    ["https://www.youtube.com/watch?v=short"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ_toolong"],
    ["https://www.youtube.com/watch?v=dQw4w9Wg<>Q"],
    ["https://www.youtube.com/playlist?list=abc"],
    ["https://youtu.be/dQw4w9WgXcQ/extra"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ/x"],
    [""],
    ["not a url"],
  ])("rejects %s", (u) => expect(parseYoutubeId(u)).toBeNull());

  it("rejects non-strings", () => expect(parseYoutubeId(undefined as never)).toBeNull());
});

describe("embedUrl", () => {
  it("builds the nocookie embed", () => expect(embedUrl(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`));
  it("refuses a bad id", () => expect(() => embedUrl("x/../y")).toThrow());
});
