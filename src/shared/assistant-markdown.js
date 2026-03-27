const ASSISTANT_REPLY_MAX_BYTES = 24 * 1024;
const DANGEROUS_HTML_TAG_RE = /<\/?(script|style|iframe|object|embed|meta|link)[^>]*>/gi;
const DANGEROUS_LINK_RE = /(\]\()\s*(javascript:|data:text\/html)[^)]+(\))/gi;

function sanitizeAssistantMarkdown(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(DANGEROUS_HTML_TAG_RE, "")
    .replace(DANGEROUS_LINK_RE, "$1about:blank$3")
    .trim();

  if (Buffer.byteLength(normalized, "utf8") <= ASSISTANT_REPLY_MAX_BYTES) {
    return normalized;
  }
  const suffix = "\n\n_内容过长，已截断显示。_";
  const budget = ASSISTANT_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  if (budget <= 0) {
    return suffix.trim();
  }
  const clipped = clipUtf8ByBytes(normalized, budget);
  return `${clipped}${suffix}`;
}

function clipUtf8ByBytes(input, maxBytes) {
  if (!input || maxBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let endIndex = 0;
  for (const char of input) {
    const next = Buffer.byteLength(char, "utf8");
    if (bytes + next > maxBytes) {
      break;
    }
    bytes += next;
    endIndex += char.length;
  }
  return input.slice(0, endIndex);
}

module.exports = {
  ASSISTANT_REPLY_MAX_BYTES,
  sanitizeAssistantMarkdown,
};
