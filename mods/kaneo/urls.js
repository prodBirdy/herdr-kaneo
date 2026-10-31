// Only links on your own Kaneo instance reach the system's opener: http or https (a self-hosted
// instance may be plain http on a LAN or tailnet), same origin as the configured `url`.
export function safeUrl(url, base) {
  try {
    const parsed = new URL(url), origin = new URL(base).origin;
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
