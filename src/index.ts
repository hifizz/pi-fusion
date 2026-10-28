import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BRIEF_DESCRIPTION, LEAD_GUIDANCE, SIDEKICK_DESCRIPTION } from "./prompts.ts";
import { createSidekickSession, PersistentSidekick } from "./sidekick.ts";
import type { SidekickReport, SidekickSession } from "./sidekick.ts";
import { usageFromPi } from "./usage.ts";

export interface FusionExtensionDeps {
  createSession?: (ctx: ExtensionContext, model: string) => Promise<SidekickSession>;
}

export function createFusionExtension(pi: ExtensionAPI, deps: FusionExtensionDeps = {}): void {
  const createSession = deps.createSession ?? createSidekickSession;
  pi.registerFlag("fusion-sidekick-model", {
    type: "string",
    description: "Sidekick provider/model; required here or via FUSION_SIDEKICK_MODEL",
  });

  let sidekick: PersistentSidekick | undefined;

  const getSidekick = (ctx: ExtensionContext): PersistentSidekick => {
    if (!sidekick) {
      const flag = pi.getFlag("fusion-sidekick-model");
      const model =
        (typeof flag === "string" ? flag.trim() : "") ||
        process.env.FUSION_SIDEKICK_MODEL?.trim();
      if (!model) {
        throw new Error("Set --fusion-sidekick-model <provider>/<model> or FUSION_SIDEKICK_MODEL before using sidekick.");
      }
      const runtimeCtx = ctx;
      sidekick = new PersistentSidekick({
        cwd: ctx.cwd,
        model,
        createSession: () => createSession(runtimeCtx, model),
        onProgress: (progress) => {
          pi.appendEntry("fusion.sidekick_usage", progress);
        },
      });
    }
    return sidekick;
  };

  pi.registerTool({
    name: "sidekick",
    label: "Sidekick",
    description: SIDEKICK_DESCRIPTION,
    executionMode: "sequential",
    parameters: Type.Object({
      brief: Type.String({ minLength: 1, description: BRIEF_DESCRIPTION }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { report, usage } = await getSidekick(ctx).run(params.brief, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        details: report,
        structuredContent: report as unknown as JsonValue,
        usage,
        isError: report.failed,
      };
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!event.systemPrompt.includes(LEAD_GUIDANCE)) {
      return { systemPrompt: `${event.systemPrompt}\n\n${LEAD_GUIDANCE}` };
    }
  });

  pi.on("session_shutdown", async () => {
    const current = sidekick;
    sidekick = undefined;
    await current?.dispose();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      pi.appendEntry("fusion.lead_usage", {
        model: `${event.message.provider}/${event.message.model}`,
        usage: usageFromPi(event.message.usage),
      });
    }
  });
}

export default function (pi: ExtensionAPI) {
  createFusionExtension(pi);
}

export type { SidekickReport };
