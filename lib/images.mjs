// What an attached image actually is.
//
// Evolv accepts JPEG, PNG, WebP and GIF, and checked that by reading the magic
// bytes — then told Anthropic and Gemini every one of them was a JPEG. Both
// providers read the bytes themselves and refuse an image whose declared type
// does not match, so attaching a screenshot, which is almost always a PNG, was
// a request neither would answer.
//
// One definition, used by the validation that accepts the file and by the
// adapters that describe it, so the two cannot disagree about what Evolv takes.
const SIGNATURES = [
  ["image/jpeg", (hex) => hex.startsWith("ffd8ff")],
  ["image/png", (hex) => hex.startsWith("89504e470d0a1a0a")],
  ["image/gif", (hex) => hex.startsWith("474946383761") || hex.startsWith("474946383961")]
];

export function imageMediaType(base64) {
  if (typeof base64 !== "string" || !base64.length) return "";
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 12) return "";
  const hex = bytes.subarray(0, 12).toString("hex");
  const match = SIGNATURES.find(([, test]) => test(hex));
  if (match) return match[0];
  // WebP is a RIFF container, so it is identified by two fields rather than a
  // prefix.
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}
