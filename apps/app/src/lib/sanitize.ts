/**
 * Allowlist sanitizer for rich-text letter and template bodies, built on HTMLRewriter
 * (there is no DOM in Workers). Unknown tags are unwrapped, dangerous ones are dropped with
 * their content, and every attribute is stripped.
 */
const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "h1", "h2", "h3", "h4", "blockquote", "hr", "span"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "textarea", "select", "svg", "math", "template", "noscript", "img", "video", "audio"]);

export async function sanitizeHtml(html: string): Promise<string> {
  const rw = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) {
        el.remove();
        return;
      }
      if (!ALLOWED.has(tag)) {
        el.removeAndKeepContent();
        return;
      }
      for (const [name] of [...el.attributes]) el.removeAttribute(name);
    },
    comments(c) {
      c.remove();
    },
  });
  const out = await rw.transform(new Response(`<body>${html}</body>`, { headers: { "content-type": "text/html" } })).text();
  return out.replace(/^<body>/, "").replace(/<\/body>$/, "").trim();
}
