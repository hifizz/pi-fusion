import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aggregateCosts, captureCost, formatFusionCost, formatFusionStatus } from "./costs.ts";
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
  let selectedSidekickModel: string | undefined;

  const configuredSidekickModel = (): string | undefined => {
    const flag = pi.getFlag("fusion-sidekick-model");
    return (typeof flag === "string" ? flag.trim() : "") || process.env.FUSION_SIDEKICK_MODEL?.trim() || undefined;
  };

  const costs = (ctx: ExtensionContext) => aggregateCosts(ctx.sessionManager.getEntries(), {
    leadModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    sidekickModel: selectedSidekickModel ?? configuredSidekickModel(),
  });
  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("fusion-cost", formatFusionStatus(costs(ctx)));
  };

  const getSidekick = (ctx: ExtensionContext): PersistentSidekick => {
    if (!sidekick) {
      const model = configuredSidekickModel();
      if (!model) {
        throw new Error("Set --fusion-sidekick-model <provider>/<model> or FUSION_SIDEKICK_MODEL before using sidekick.");
      }
      selectedSidekickModel = model;
      const runtimeCtx = ctx;
      sidekick = new PersistentSidekick({
        cwd: ctx.cwd,
        model,
        createSession: () => createSession(runtimeCtx, model),
        onProgress: (progress) => {
          pi.appendEntry("fusion.sidekick_usage", progress);
          if (progress.complete) updateStatus(runtimeCtx);
        },
      });
    }
    return sidekick;
  };

  pi.registerCommand("fusion-cost", {
    description: "Show recorded lead and sidekick tokens and estimated USD cost",
    handler: async (_args, ctx) => { ctx.ui.notify(formatFusionCost(costs(ctx)), "info"); },
  });

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

  pi.on("session_start", (_event, ctx) => {
    pi.appendEntry("fusion.models", {
      leadModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      sidekickModel: configuredSidekickModel(),
    });
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = sidekick;
    sidekick = undefined;
    selectedSidekickModel = undefined;
    try {
      await current?.dispose();
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus("fusion-cost", undefined);
    }
  });

  pi.on("turn_end", (_event, ctx) => updateStatus(ctx));

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role === "assistant") {
      const model = ctx.model?.provider === message.provider && ctx.model.id === message.model
        ? ctx.model : ctx.modelRegistry.find(message.provider, message.model);
      pi.appendEntry("fusion.lead_usage", {
        model: `${message.provider}/${message.model}`,
        usage: usageFromPi(message.usage),
        ...captureCost(message.usage, model, ctx.modelRegistry.getRegisteredProviderConfig(message.provider)),
      });
      updateStatus(ctx);
    }
  });
}

export default function (pi: ExtensionAPI) {
  createFusionExtension(pi);
}

export type { SidekickReport };
