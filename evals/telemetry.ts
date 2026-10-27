import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Eval-only attribution: shell writes count too, rather than guessing from shell text. */
export default function telemetry(pi: ExtensionAPI): void {
  const before = new Map<string, Map<string, string>>();
  function snapshot(cwd: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (relative: string) => {
      for (const name of readdirSync(join(cwd, relative)).sort()) {
        if ([".git", "node_modules", ".pi", ".hidden"].includes(name)) continue;
        const path = join(relative, name);
        const stat = lstatSync(join(cwd, path));
        if (stat.isSymbolicLink()) files.set(path, "<symlink>");
        else if (stat.isDirectory()) walk(path);
        else if (stat.isFile()) {
          files.set(path, createHash("sha256").update(readFileSync(join(cwd, path))).digest("hex"));
        }
      }
    };
    walk("");
    return files;
  }
  // Print mode subscribes after session_start; before_agent_start is on the JSON stream.
  pi.on("before_agent_start", () => { pi.appendEntry("fusion.telemetry_ready", { version: 1 }); });
  pi.on("tool_call", (event, ctx) => {
    if (["bash", "write", "edit"].includes(event.toolName)) before.set(event.toolCallId, snapshot(ctx.cwd));
  });
  pi.on("tool_result", (event, ctx) => {
    const previous = before.get(event.toolCallId);
    if (!previous) return;
    before.delete(event.toolCallId);
    const after = snapshot(ctx.cwd);
    const changedFiles = [...new Set([...previous.keys(), ...after.keys()])]
      .filter((path) => previous.get(path) !== after.get(path)).sort();
    if (changedFiles.length || (!event.isError && ["write", "edit"].includes(event.toolName))) {
      pi.appendEntry("fusion.lead_mutation", {
        toolCallId: event.toolCallId, toolName: event.toolName, changedFiles,
      });
    }
  });
}
