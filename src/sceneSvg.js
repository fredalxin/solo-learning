function scopeCss(css, scope) {
  let cursor = 0;
  let result = "";
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open < 0) return result + css.slice(cursor);
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth) {
      if (css[close] === "{") depth += 1;
      if (css[close] === "}") depth -= 1;
      close += 1;
    }
    const header = css.slice(cursor, open);
    const trimmed = header.trim();
    if (!trimmed || trimmed.startsWith("@")) {
      result += css.slice(cursor, close);
    } else {
      const leading = header.slice(0, header.indexOf(trimmed));
      const selectors = trimmed.split(",").map((selector) => {
        const clean = selector.trim();
        if (/^svg(?=\b|[:.#[])/.test(clean)) return clean.replace(/^svg/, scope);
        if (/^:root\b/.test(clean)) return clean.replace(/^:root/, scope);
        return `${scope} ${clean}`;
      }).join(",");
      result += `${leading}${selectors}${css.slice(open, close)}`;
    }
    cursor = close;
  }
  return result;
}

export function scopeSceneSvgStyles(svg) {
  const source = String(svg || "");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const id = `scene-${(hash >>> 0).toString(36)}`;
  const selector = `[data-scene-scope="${id}"]`;
  return source
    .replace(/^<svg\b/i, `<svg data-scene-scope="${id}"`)
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attributes, css) => (
      `<style${attributes}>${scopeCss(css, selector)}</style>`
    ));
}
