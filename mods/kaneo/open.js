import { exec, window } from "herdr";
import { safeUrl } from "./urls.js";

// The system's opener, on this computer even for a space on another machine.
function opener(url) {
  const platform = window()?.platform;
  if (platform === "macos") return ["open", ["--", url]];
  if (platform === "windows") return ["explorer", [url]];
  return ["xdg-open", [url]];
}

// Only links on the configured Kaneo instance (`base`) are opened.
export function openUrl(url, base) {
  const safe = safeUrl(url, base);
  if (!safe) return;
  const [command, args] = opener(safe);
  exec(command, args).catch(() => {});
}
