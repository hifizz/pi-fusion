import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimited: boolean;
  durationMs: number;
}

/** No shell interpolation; stdin is /dev/null. Timeout kills the whole process group. */
export async function runProcess(
  command: string, args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes?: number },
): Promise<ProcessResult> {
  const started = performance.now();
  const limit = options.maxOutputBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let forceKill: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      forceKill ??= setTimeout(() => {
        killGroup("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const receive = (target: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, limit - bytes);
      if (available) target.push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > limit) { outputLimited = true; stop(); }
    };
    child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      // Also reap tool processes which outlived an otherwise successful Pi exit.
      killGroup("SIGKILL");
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode, signal, timedOut, outputLimited,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
