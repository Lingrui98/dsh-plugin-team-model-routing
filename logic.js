/**
 * Pure routing logic for the Team Model Routing bundle.
 *
 * This module deliberately imports nothing so it stays testable with plain
 * Node: route validation, allowlist enforcement, route discovery, and the
 * claim bookkeeping all live here. `index.js` adds the Cordis glue.
 *
 * @module dsh-plugin-team-model-routing/logic
 */

/** Every context the shipped Team service supports. */
export const CONTEXTS = new Set(['fresh', 'fork']);

/** Shared wording contract for a teammate description, kept in sync with the Team service. */
export const DESCRIPTION_LIMIT = 200;

/** Upper bound on a raw teammate description, or a diagnostic. */
export function normalizeDescription(value, field) {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new Error(`teammate \`${field}\` must be a non-empty string`);
	if (value.length > DESCRIPTION_LIMIT)
		throw new Error(
			`teammate \`${field}\` must be at most ${DESCRIPTION_LIMIT} characters (got ${value.length})`,
		);
	return value;
}

/** Stable identity for one recorded route request. */
export function routeKey(description, context) {
	return `${context}\u0000${description}`;
}

/** Render one provider/model pair. */
export function routeLine(route) {
	return `${route.provider}/${route.model}`;
}

/**
 * Extract the teammate name from the initial message the Team tool composes.
 *
 * The shipped tool prefixes every teammate with
 * `You are teammate "<name>".`, which is the only durable string that ties a
 * materialized child back to the spawn call that requested its route.
 *
 * @param {string} text - a text block from the child's claimed or recorded input.
 * @returns the teammate name, or undefined when this is not a teammate prompt.
 */
export function teammateNameFromPrompt(text) {
	if (typeof text !== 'string') return undefined;
	const match = /You are teammate "([a-z0-9]+(?:-[a-z0-9]+)*)"\./u.exec(text);
	return match?.[1];
}

/** Concatenate the text blocks of one content block array. */
export function contentText(content) {
	if (!Array.isArray(content)) return '';
	return content
		.filter(
			(block) =>
				block !== null &&
				typeof block === 'object' &&
				block.type === 'text' &&
				typeof block.text === 'string',
		)
		.map((block) => block.text)
		.join('');
}

/**
 * Find the teammate name among the messages one step is about to enter.
 *
 * A child's first step receives its initial prompt through the step's claimed
 * messages — the Team service submits it to the child's inbox, and the loop
 * only appends it to the transcript inside that step. Reading the session
 * snapshot too early therefore finds nothing, which is exactly the defect this
 * shape avoids.
 *
 * @param {readonly object[]} messages - the step's claimed user messages.
 * @returns the teammate name, or undefined when none of them is a teammate prompt.
 */
export function teammateNameFromMessages(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (const message of messages) {
		const name = teammateNameFromPrompt(contentText(message?.content));
		if (name !== undefined) return name;
	}
	return undefined;
}

/**
 * Per-Lead bookkeeping for routes whose teammate does not exist yet.
 *
 * The shipped Team service mints the child id internally, so the route cannot
 * be keyed by child. `(Lead, description, context)` is instead derived
 * deterministically from the same tool call on both sides, and a Team never
 * reuses a teammate name — so a claimed route can only ever reach the teammate
 * it was recorded for. Recorded routes expire, so a spawn that fails before it
 * reaches a provider cannot affect a much later teammate.
 */
export class PendingRouteStore {
	/** @type {Map<string, Array<{key: string, createdAt: number, options: object}>>} */
	byLead = new Map();
	#ttlMs;

	/** @param {number} ttlMs - how long a recorded route stays claimable. */
	constructor(ttlMs) {
		this.#ttlMs = ttlMs;
	}

	/** Record the route the Lead is about to request. */
	record(leadSessionId, description, context, options) {
		const entries = this.#live(leadSessionId);
		entries.push({
			key: routeKey(description, context),
			createdAt: Date.now(),
			options,
		});
	}

	/** Undo a record whose spawn never reached the provider. */
	discard(leadSessionId, description, context) {
		const key = routeKey(description, context);
		const entries = this.#live(leadSessionId);
		const index = entries.findIndex((entry) => entry.key === key);
		if (index >= 0) entries.splice(index, 1);
		if (entries.length === 0) this.byLead.delete(leadSessionId);
	}

	/** Claim the route for one provider start, or undefined for inherited routing. */
	claim(leadSessionId, description, context) {
		const key = routeKey(description, context);
		const entries = this.#live(leadSessionId);
		const index = entries.findIndex((entry) => entry.key === key);
		if (index < 0) return undefined;
		const [claimed] = entries.splice(index, 1);
		if (entries.length === 0) this.byLead.delete(leadSessionId);
		return claimed.options;
	}

	/** Drop expired entries; a recorded route is only meaningful across one tool call. */
	#live(leadSessionId) {
		const entries = (this.byLead.get(leadSessionId) ?? []).filter(
			(entry) => Date.now() - entry.createdAt < this.#ttlMs,
		);
		this.byLead.set(leadSessionId, entries);
		return entries;
	}
}

/**
 * The allowlist in force, or undefined when the Lead may choose freely.
 *
 * An enabled setting with an empty route list is not a configuration error the
 * Lead should hit while merely inheriting the Lead route: inheritance carries
 * no model-facing choice. It simply makes every route unselectable, so
 * `routeCandidates` renders the empty list and explicit requests are rejected
 * against it.
 */
export function activePolicy(ctx) {
	const settings = ctx.get('subagentModelSelection');
	if (settings === undefined || typeof settings.current !== 'function')
		return undefined;
	const current = settings.current();
	if (!current?.enabled) return undefined;
	const routes = Array.isArray(current.allowedModels) ? current.allowedModels : [];
	return routes.map((route) => ({
		provider: route.provider,
		model: route.model,
	}));
}

/** Every route the Lead may name right now, as a diagnostic string. */
export function routeCandidates(ctx) {
	const policy = activePolicy(ctx);
	if (policy !== undefined) return policy.map(routeLine);
	const llm = ctx.get('llm');
	if (llm === undefined) return [];
	return llm.listProviders().map((provider) => `${provider.id}/*`);
}

/**
 * Validate a requested teammate route before the teammate exists.
 *
 * Explicit routing is checked against the allowlist; inheritance is not, which
 * matches the shipped `subagent` tool. The LLM runtime owns exact-model
 * metadata and effort validation, so the last step resolves the call config
 * through the live adapter rather than guessing.
 */
export async function resolveRoute(ctx, request, signal) {
	const provider = request.provider;
	const model = request.model;
	const effort = request.reasoning_effort;
	if (provider === undefined && model === undefined && effort === undefined)
		return undefined;
	if ((provider === undefined) !== (model === undefined))
		throw new Error(
			'teammate `provider` and `model` must be supplied together; omit all three fields to inherit the Lead route',
		);
	if (effort !== undefined && provider === undefined)
		throw new Error(
			'teammate `reasoning_effort` requires an explicit `provider` and `model`',
		);
	const policy = activePolicy(ctx);
	if (
		policy !== undefined &&
		!policy.some((route) => route.provider === provider && route.model === model)
	)
		throw new Error(
			`teammate LLM route "${provider}/${model}" is not allowed by the Subagent model-selection allowlist; allowed: ${
				policy.map(routeLine).join(', ') || '(none)'
			}`,
		);
	const llm = ctx.get('llm');
	if (llm === undefined)
		throw new Error(
			'team-model-routing: cannot resolve a teammate LLM route because the `llm` service is unavailable',
		);
	try {
		await llm.resolveCallConfig(
			{
				provider,
				model,
				...(effort === undefined ? {} : { reasoningEffort: effort }),
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`teammate LLM route "${provider}/${model}" was rejected by the adapter: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return {
		provider,
		model,
		...(effort === undefined ? {} : { reasoningEffort: effort }),
	};
}

/** Render the route discovery answer. */
export async function listRoutes(ctx, request, signal) {
	const llm = ctx.get('llm');
	if (llm === undefined)
		throw new Error(
			'team-model-routing: cannot discover teammate routes because the `llm` service is unavailable',
		);
	const policy = activePolicy(ctx);
	const allowed = (providerId) =>
		policy === undefined ||
		policy.some((route) => route.provider === providerId);
	const providers = llm.listProviders().filter((provider) => allowed(provider.id));
	if (request.provider === undefined)
		return providers.length === 0
			? '(no selectable LLM providers)'
			: providers.map((provider) => `${provider.id} — ${provider.name}`).join('\n');
	if (typeof request.provider !== 'string' || request.provider.length === 0)
		throw new Error('`provider` must be non-empty');
	if (!providers.some((provider) => provider.id === request.provider))
		throw new Error(
			`LLM provider "${request.provider}" is not selectable for teammates; selectable routes: ${
				routeCandidates(ctx).join(', ') || '(none)'
			}`,
		);
	if (request.model === undefined) {
		const models = (await llm.listModels(request.provider)).filter(
			(model) =>
				policy === undefined ||
				policy.some(
					(route) =>
						route.provider === request.provider && route.model === model.id,
				),
		);
		return models.length === 0
			? `(no selectable models for ${request.provider})`
			: models.map((model) => `${model.id} — ${model.name}`).join('\n');
	}
	if (typeof request.model !== 'string' || request.model.length === 0)
		throw new Error('`model` must be non-empty');
	if (policy !== undefined) {
		const requested = { provider: request.provider, model: request.model };
		if (!policy.some((route) => routeLine(route) === routeLine(requested)))
			throw new Error(
				`teammate LLM route "${routeLine(requested)}" is not allowed by the Subagent model-selection allowlist`,
			);
	}
	const model = await llm.resolveModelInfo(request.provider, request.model, signal);
	const efforts =
		(model.reasoning?.efforts ?? [])
			.map(
				(effort) =>
					`${effort.id}${
						model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''
					} — ${effort.name}` +
					(effort.description === undefined ? '' : `: ${effort.description}`),
			)
			.join('\n') || '(no advertised reasoning efforts)';
	return `${request.provider}/${model.id} — ${model.name}\nReasoning efforts:\n${efforts}`;
}
