import { writeReport } from "./report.ts";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: pnpm report results/<directory>");
  const summary = writeReport(args[0]);
  console.log(`Report generated for ${summary.runCount} runs: ${args[0]}/report.md`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Report generation failed");
  process.exitCode = 1;
}
