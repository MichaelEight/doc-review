// Open a URL in the user's default browser, on macOS, Windows and Linux.
import { execFile } from "node:child_process";

export function openUrl(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
