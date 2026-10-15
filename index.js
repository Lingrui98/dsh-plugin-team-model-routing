/**
 * Team Model Routing — a DSH Host plugin that lets an Agent Teams Lead choose
 * the provider, model, and reasoning effort of each teammate it spawns.
 *
 * Why this exists: `spawn_teammate` carries no route fields, and
 * `ctx.agentTeams.spawnTeammate()` forwards only a provider *name* to
 * `ctx.subagents.startContinuable()`, which is where `agentOptions` live. A
 * teammate is a *continuable* child, so the continuation registry materializes
 * it through `ctx.agents.create()` — a wrapper subagent provider is therefore
 * never asked to start it, and injecting at the provider seam does nothing.
 *
 * The seam that does work is the child's own step pipeline:
 *
 *   1. `spawn_teammate_routed` validates the requested route, records it under
 *      `(Lead session, description, context)`, and then calls the shipped Team
 *      service — the tool contract is unchanged.
 *   2. On each step, the recorded route is claimed for the teammate whose
 *      durable initial message names it, and the child's resolved
 *      `AgentOptions` are rewritten before the step's request is prepared.
 *      `AgentLoop.prepareRequest()` reads `this.options` per step and the step
 *      reads it after `agent/pre-step` resolves, so the rewrite reaches the
 *      logged `request/header`, the model source on assistant messages, and
 *      every later step of the same teammate.
 *
 * A route is plain data owned by this process, so the claim is atomic; a
 * recorded route whose spawn never happened expires unclaimed.
 *
 * @module dsh-plugin-team-model-routing
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
	CONTEXTS,
	PendingRouteStore,
	contentText,
	listRoutes,
	normalizeDescription,
	resolveRoute,
	routeLine,
	teammateNameFromMessages,
	teammateNameFromPrompt,
} from './logic.js';

export {
	CONTEXTS,
	DESCRIPTION_LIMIT,
	PendingRouteStore,
	activePolicy,
	contentText,
	listRoutes,
	normalizeDescription,
	resolveRoute,
	routeCandidates,
	routeLine,
	teammateNameFromMessages,
	teammateNameFromPrompt,
} from './logic.js';

/** Cordis plugin name. */
export const name = 'team-model-routing';

/** Services this plugin reads. */
export const inject = [
	'agents',
	'agentTeams',
	'tools',
	'systemPrompt',
];

/** Loader schema for this plugin's row. */
export const Config = z.object({
	toolName: z.string().default('spawn_teammate_routed'),
	listToolName: z.string().default('list_teammate_models'),
	freshProvider: z.string().default('spawn'),
	forkProvider: z.string().default('fork'),
	routeTtlMs: z.number().step(1).min(1).default(120_000),
});

/**
 * Route one teammate, lazily, from its own first step.
 *
 * The listener is installed for every Agent and resolves the claim while the
 * child's first step is starting. That instant is the only one that works: the
 * Team service submits the initial prompt to the child's inbox after the Agent
 * is created, and the loop appends it to the transcript only inside that step,
 * after the request is prepared. The name therefore comes from the step's
 * claimed messages, with the transcript as the fallback that a resumed
 * teammate needs, and the rewrite lands before `prepareRequest` reads the
 * resolved options (which it does on every step).
 *
 * The listener lives in the child's own scoped context, so it only observes
 * that child, and it is a no-op for the Lead and for ordinary subagents.
 */
function routeTeammate(child, ctx, store, routed) {
	const disposer = child.ctx.on('agent/pre-step', async (payload, next) => {
		if (!routed.has(child.id)) {
			routed.add(child.id);
			try {
				resolveRouteFor(child, payload, ctx, store);
			} catch (error) {
				ctx.logger.warn(
					`team-model-routing: could not route Agent "${child.id}": ${String(error)}`,
				);
			}
		}
		return await next();
	});
	ctx.on('agent/disposed', ({ agent }) => {
		if (agent !== child) return;
		routed.delete(child.id);
		disposer?.();
	});
}

/** The teammate name a child's own transcript records, if it carries one. */
function nameFromTranscript(child) {
	try {
		const events = child.session.snapshotEvents(child.session.inheritedEventCount);
		for (const event of events) {
			if (event.type !== 'user/message') continue;
			const name = teammateNameFromPrompt(contentText(event.data?.content));
			if (name !== undefined) return name;
		}
	} catch {
		// A transcript that cannot be read simply yields no name.
	}
	return undefined;
}

/** Resolve and apply one child's route, logging every outcome. */
function resolveRouteFor(child, payload, ctx, store) {
	const parentId = child.session?.header?.parentSession;
	// A teammate is the only kind of child the Team service gives a parent.
	if (parentId === undefined) return;
	const name =
		teammateNameFromMessages(payload?.messages) ?? nameFromTranscript(child);
	if (name === undefined) return;
	// The Team service picked one context for this child; claims are atomic and
	// the tool records exactly one, so probing both is unambiguous. Probing by
	// `context` (rather than remembering it per name) is what keeps this store
	// free of a second, never-pruned index.
	const route =
		store.claim(parentId, name, 'fresh') ?? store.claim(parentId, name, 'fork');
	if (route === undefined) return;
	applyRoute(child, route);
	ctx.logger.info(
		`team-model-routing: teammate "${name}" now runs on ${routeLine(route)}${
			route.reasoningEffort === undefined
				? ''
				: ` (effort ${route.reasoningEffort})`
		}`,
	);
}

/** Rewrite the resolved AgentOptions that the next step's request will use. */
function applyRoute(child, route) {
	const options = child.options ?? {};
	options.provider = route.provider;
	options.model = route.model;
	if (route.reasoningEffort === undefined) delete options.reasoningEffort;
	else options.reasoningEffort = route.reasoningEffort;
	child.options = options;
}

/** One member row, matching the Team tool's own model-facing projection. */
const MEMBER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		target: { type: 'string', required: true },
		role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
		status: {
			type: 'string',
			required: true,
			enum: ['running', 'inactive', 'provisioning', 'failed'],
		},
		description: { type: 'string' },
		provider: { type: 'string' },
		context: { type: 'string', enum: ['fresh', 'fork'] },
		model: { type: 'string' },
		diagnostics: { type: 'array', required: true, items: { type: 'string' } },
	},
};

/** Project one roster row into the model-facing shape. */
function modelMember(member) {
	const { id: _id, name: memberName, ...details } = member;
	return { target: memberName, ...details };
}

/** The spawn tool definition for one Lead scope. */
function spawnToolDefinition(ctx, config, store) {
	return defineTool({
		name: config.toolName,
		description:
			'Create one named, durable teammate pinned to a chosen LLM route. Only the Team Lead may call this tool. Omit `provider`, `model`, and `reasoning_effort` to inherit the Lead route, which is what `spawn_teammate` always does. Use `list_teammate_models` to discover selectable routes and their reasoning efforts first.',
		parameters: {
			name: {
				type: 'string',
				required: true,
				description: 'Unique lower-kebab-case teammate name.',
			},
			description: {
				type: 'string',
				required: true,
				description: 'Short description of the delegated responsibility.',
			},
			prompt: {
				type: 'string',
				required: true,
				description: 'Complete initial task for the teammate.',
			},
			context: {
				type: 'string',
				enum: ['fresh', 'fork'],
				description:
					'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
			},
			provider: {
				type: 'string',
				description:
					'LLM provider route for this teammate. Supply together with `model`; omit both to inherit the Lead route.',
			},
			model: {
				type: 'string',
				description:
					'Model id interpreted by `provider`. Supply together with `provider`.',
			},
			reasoning_effort: {
				type: 'string',
				description:
					'Adapter-owned reasoning effort for this teammate. Omit to inherit a compatible effort or use the selected model default.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: { member: { ...MEMBER_SCHEMA, required: true } },
			},
			render: (_args, value) => [
				{ type: 'text', text: JSON.stringify(value) },
			],
		},
		async execute(args, exec) {
			const lead = exec.agent;
			if (lead === undefined)
				throw new Error(
					`${config.toolName} requires a calling Agent (exec.agent was undefined)`,
				);
			const description = normalizeDescription(args.description, 'description');
			const context = args.context ?? 'fresh';
			if (!CONTEXTS.has(context))
				throw new Error('teammate `context` must be "fresh" or "fork"');
			const route = await resolveRoute(ctx, args, exec.signal);
			if (route !== undefined) {
				// The name is durable and unique inside one Team, so it is the key the
				// routing hook can recover from the child's own first step.
				store.record(lead.id, args.name.trim(), context, route);
			}
			try {
				const result = await ctx.agentTeams.spawnTeammate(lead, {
					name: args.name,
					description,
					prompt: [
						{
							type: 'text',
							text: `<system-reminder>
You are teammate "${args.name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`,
						},
						{ type: 'text', text: args.prompt },
					],
					context,
					provider:
						context === 'fork' ? config.forkProvider : config.freshProvider,
					signal: exec.signal,
				});
				return { member: modelMember(result.member) };
			} catch (error) {
				if (route !== undefined)
					store.discard(lead.id, args.name.trim(), context);
				throw error;
			}
		},
	});
}

/** The route discovery tool definition. */
function listToolDefinition(ctx, config) {
	return defineTool({
		name: config.listToolName,
		description:
			'Discover LLM routes a teammate can be spawned on, without changing the current Agent. Call with no arguments to list selectable providers, with `provider` to list its selectable models, or with `provider` and `model` to inspect that exact model and its reasoning efforts. Use the returned ids with `spawn_teammate_routed`.',
		parameters: {
			provider: {
				type: 'string',
				description: 'LLM provider id. Omit to list selectable providers.',
			},
			model: {
				type: 'string',
				description: 'Exact model id to inspect. Requires `provider`.',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		execute(args, exec) {
			return listRoutes(ctx, args, exec.signal);
		},
	});
}

/** Guidance installed beside the tools for the Team Lead only. */
function leadGuidance(config) {
	return (
		`\`${config.toolName}\` creates a teammate pinned to a chosen LLM route, and \`${config.listToolName}\` lists the routes and reasoning efforts you may name. ` +
		`Use \`${config.listToolName}\` before selecting a route. Omit \`provider\`, \`model\`, and \`reasoning_effort\` to inherit the Lead route. ` +
		'When the Subagent model-selection allowlist is enabled, explicit routes outside it are rejected before the teammate is created.'
	);
}

/**
 * Install the Lead-scoped tools in one live Team member scope.
 *
 * Registration goes through `agent.ctx.inject` because a scoped tool must live
 * in that Agent's own scope — a context-global tool would be visible to every
 * Agent — and because the scope's services must be resolved before the tools
 * are declared.
 */
function installScoped(agent, ctx, config, store) {
	const fiber = agent.ctx.inject(['tools', 'systemPrompt'], (scoped) => {
		const disposers = [
			scoped.tools.register(spawnToolDefinition(ctx, config, store)),
			scoped.tools.register(listToolDefinition(ctx, config)),
			scoped.systemPrompt.section({
				// Derived from the tool name so two generations of this plugin can
				// coexist in one scope without colliding on the section name.
				name: `tool:${config.toolName}`,
				order: scoped.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
				text: leadGuidance(config),
			}),
		];
		return () => {
			for (const dispose of disposers.reverse()) dispose();
		};
	});
	return () => {
		// `inject` resolves to a Fiber only while its dependency fiber is live.
		fiber?.dispose?.().catch((error) => {
			ctx.logger.warn(
				`team-model-routing: failed to remove tools for Agent "${agent.id}": ${String(error)}`,
			);
		});
	};
}

/** Cordis plugin entry point. */
export function apply(ctx, rawConfig = {}) {
	const config = {
		toolName: rawConfig.toolName ?? 'spawn_teammate_routed',
		listToolName: rawConfig.listToolName ?? 'list_teammate_models',
		freshProvider: rawConfig.freshProvider ?? 'spawn',
		forkProvider: rawConfig.forkProvider ?? 'fork',
		routeTtlMs: rawConfig.routeTtlMs ?? 120_000,
	};
	const store = new PendingRouteStore(config.routeTtlMs);
	const applied = new Set();
	ctx.on('agent/created', ({ agent }) => {
		try {
			routeTeammate(agent, ctx, store, applied);
		} catch (error) {
			ctx.logger.warn(
				`team-model-routing: could not route Agent "${agent.id}": ${String(error)}`,
			);
		}
	});

	const installed = new Map();
	const maybeInstall = (agent) => {
		if (installed.has(agent)) return;
		if (ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return;
		installed.set(agent, installScoped(agent, ctx, config, store));
	};
	for (const agent of ctx.agents.list()) maybeInstall(agent);
	ctx.on('agent/created', ({ agent }) => {
		maybeInstall(agent);
	});
	ctx.on('agent/disposed', ({ agent }) => {
		installed.get(agent)?.();
		installed.delete(agent);
	});
	ctx.effect(
		() => () => {
			for (const dispose of installed.values()) dispose();
			installed.clear();
		},
		'team-model-routing.registration()',
	);
}
