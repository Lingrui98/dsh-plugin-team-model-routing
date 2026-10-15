/**
 * Standalone logic test for the Team Model Routing bundle. It exercises the
 * route validation and claim semantics with a stub Cordis context, so it can
 * run with plain Node before anything is installed.
 *
 *   node packages/team-model-routing/test/logic.test.mjs
 */

import assert from 'node:assert/strict';
import {
	PendingRouteStore,
	contentText,
	listRoutes,
	resolveRoute,
	teammateNameFromMessages,
	teammateNameFromPrompt,
} from '../logic.js';

/** Build a stub context exposing only the services the logic reads. */
function stubCtx({ policy, providers = {}, models = {} } = {}) {
	return {
		get(service) {
			if (service === 'subagentModelSelection')
				return policy === undefined ? undefined : { current: () => policy };
			if (service === 'llm')
				return {
					listProviders: () =>
						Object.entries(providers).map(([id, name]) => ({ id, name })),
					listModels: async (provider) => models[provider] ?? [],
					resolveModelInfo: async (provider, model) => {
						const entry = (models[provider] ?? []).find(
							(candidate) => candidate.id === model,
						);
						if (entry === undefined) throw new Error(`unknown model ${provider}/${model}`);
						return entry;
					},
					resolveCallConfig: async (config) => {
						const entry = (models[config.provider] ?? []).find(
							(candidate) => candidate.id === config.model,
						);
						if (entry === undefined)
							throw new Error(`adapter does not serve ${config.provider}/${config.model}`);
						if (
							config.reasoningEffort !== undefined &&
							!(entry.reasoning?.efforts ?? []).some(
								(effort) => effort.id === config.reasoningEffort,
							)
						)
							throw new Error(`unsupported reasoning effort ${config.reasoningEffort}`);
						return config;
					},
				};
			return undefined;
		},
	};
}

const signal = new AbortController().signal;
const results = [];
const check = async (label, run) => {
	try {
		await run();
		results.push(`ok   ${label}`);
	} catch (error) {
		results.push(`FAIL ${label}\n     ${error.message}`);
		process.exitCode = 1;
	}
};

const llmFixture = {
	providers: { 'deepseek-account': 'DeepSeek', 'pi-ai': 'Pi AI' },
	models: {
		'deepseek-account': [
			{
				id: 'deepseek-flash',
				name: 'DeepSeek Flash',
				reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
			},
			{
				id: 'gpt-6.1-sol',
				name: 'GPT 6.1 Sol',
				reasoning: {
					efforts: [
						{ id: 'medium', name: 'Medium' },
						{ id: 'high', name: 'High' },
					],
					defaultEffort: 'medium',
				},
			},
		],
		'pi-ai': [{ id: 'other', name: 'Other' }],
	},
};

await check('an omitted route inherits (undefined)', async () => {
	const ctx = stubCtx({ ...llmFixture });
	assert.equal(await resolveRoute(ctx, {}, signal), undefined);
	assert.equal(
		await resolveRoute(ctx, { provider: undefined, model: undefined }, signal),
		undefined,
	);
});

await check('an explicit route resolves when no allowlist is set', async () => {
	const ctx = stubCtx({ ...llmFixture });
	assert.deepEqual(
		await resolveRoute(
			ctx,
			{ provider: 'deepseek-account', model: 'gpt-6.1-sol', reasoning_effort: 'high' },
			signal,
		),
		{ provider: 'deepseek-account', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
	);
});

await check('provider without model is rejected', async () => {
	const ctx = stubCtx({ ...llmFixture });
	await assert.rejects(
		resolveRoute(ctx, { provider: 'deepseek-account' }, signal),
		/supplied together/,
	);
});

await check('effort without a route is rejected', async () => {
	const ctx = stubCtx({ ...llmFixture });
	await assert.rejects(
		resolveRoute(ctx, { reasoning_effort: 'high' }, signal),
		/requires an explicit/,
	);
});

await check('an unsupported effort is rejected by the adapter', async () => {
	const ctx = stubCtx({ ...llmFixture });
	await assert.rejects(
		resolveRoute(
			ctx,
			{ provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'high' },
			signal,
		),
		/unsupported reasoning effort/,
	);
});

await check('an unknown route is rejected by the adapter', async () => {
	const ctx = stubCtx({ ...llmFixture });
	await assert.rejects(
		resolveRoute(ctx, { provider: 'deepseek-account', model: 'nope' }, signal),
		/rejected by the adapter/,
	);
});

await check('an enabled allowlist rejects a route outside it', async () => {
	const ctx = stubCtx({
		...llmFixture,
		policy: {
			enabled: true,
			allowedModels: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
		},
	});
	await assert.rejects(
		resolveRoute(ctx, { provider: 'deepseek-account', model: 'gpt-6.1-sol' }, signal),
		/not allowed by the Subagent model-selection allowlist/,
	);
	assert.deepEqual(
		await resolveRoute(
			ctx,
			{ provider: 'deepseek-account', model: 'deepseek-flash' },
			signal,
		),
		{ provider: 'deepseek-account', model: 'deepseek-flash' },
	);
});

await check('an enabled allowlist still permits pure inheritance', async () => {
	const ctx = stubCtx({
		...llmFixture,
		policy: {
			enabled: true,
			allowedModels: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
		},
	});
	assert.equal(await resolveRoute(ctx, {}, signal), undefined);
});

await check('an enabled empty allowlist blocks explicit routing but not inheritance', async () => {
	const ctx = stubCtx({ ...llmFixture, policy: { enabled: true, allowedModels: [] } });
	await assert.rejects(
		resolveRoute(ctx, { provider: 'deepseek-account', model: 'deepseek-flash' }, signal),
		/not allowed by the Subagent model-selection allowlist/,
	);
	assert.equal(await resolveRoute(ctx, {}, signal), undefined);
	assert.equal(await listRoutes(ctx, {}, signal), '(no selectable LLM providers)');
});

await check('discovery lists only allowlisted routes', async () => {
	const ctx = stubCtx({
		...llmFixture,
		policy: {
			enabled: true,
			allowedModels: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
		},
	});
	assert.equal(await listRoutes(ctx, {}, signal), 'deepseek-account — DeepSeek');
	assert.equal(
		await listRoutes(ctx, { provider: 'deepseek-account' }, signal),
		'deepseek-flash — DeepSeek Flash',
	);
	assert.match(
		await listRoutes(
			ctx,
			{ provider: 'deepseek-account', model: 'deepseek-flash' },
			signal,
		),
		/low \(default\) — Low/,
	);
	await assert.rejects(
		listRoutes(ctx, { provider: 'pi-ai' }, signal),
		/not selectable for teammates/,
	);
});

await check('discovery lists every provider without a policy', async () => {
	const ctx = stubCtx({ ...llmFixture });
	assert.equal(
		await listRoutes(ctx, {}, signal),
		'deepseek-account — DeepSeek\npi-ai — Pi AI',
	);
});

await check('a recorded route is claimed once, by its exact key', async () => {
	const store = new PendingRouteStore(60_000, () => {});
	const options = { provider: 'p', model: 'm' };
	store.record('lead-1', 'audit the parser', 'fresh', options);
	assert.deepEqual(store.claim('lead-1', 'audit the parser', 'fresh'), options);
	assert.equal(store.claim('lead-1', 'audit the parser', 'fresh'), undefined);
});

await check('a route never leaks across Lead, description, or context', async () => {
	const store = new PendingRouteStore(60_000, () => {});
	const options = { provider: 'p', model: 'm' };
	store.record('lead-1', 'audit the parser', 'fresh', options);
	assert.equal(store.claim('lead-2', 'audit the parser', 'fresh'), undefined);
	assert.equal(store.claim('lead-1', 'audit the lexer', 'fresh'), undefined);
	assert.equal(store.claim('lead-1', 'audit the parser', 'fork'), undefined);
	assert.deepEqual(store.claim('lead-1', 'audit the parser', 'fresh'), options);
});

await check('discard drops a route whose spawn never happened', async () => {
	const store = new PendingRouteStore(60_000, () => {});
	store.record('lead-1', 'audit the parser', 'fresh', { provider: 'p', model: 'm' });
	store.discard('lead-1', 'audit the parser', 'fresh');
	assert.equal(store.claim('lead-1', 'audit the parser', 'fresh'), undefined);
});

await check('an expired route is never applied', async () => {
	const store = new PendingRouteStore(1, () => {});
	store.record('lead-1', 'audit the parser', 'fresh', { provider: 'p', model: 'm' });
	await new Promise((resolve) => setTimeout(resolve, 12));
	assert.equal(store.claim('lead-1', 'audit the parser', 'fresh'), undefined);
});

await check('the teammate name is recovered from the shipped prompt prefix', async () => {
	const prompt =
		'<system-reminder>\nYou are teammate "verify-routing-impl".\nYour Team Lead is named "lead".\n</system-reminder>\n\ndo the thing';
	assert.equal(teammateNameFromPrompt(prompt), 'verify-routing-impl');
	assert.equal(teammateNameFromPrompt('You are teammate "a-b-c".'), 'a-b-c');
	assert.equal(teammateNameFromPrompt('You are teammate "Bad_Name".'), undefined);
	assert.equal(teammateNameFromPrompt('unrelated text'), undefined);
	assert.equal(teammateNameFromPrompt(undefined), undefined);
});

await check('the name is recovered from the step messages, not the transcript', async () => {
	const content = [
		{ type: 'text', text: '<system-reminder>\nYou are teammate "audit-parser".\n' },
		{ type: 'image', attachment: { attachmentId: 'x' } },
		{ type: 'text', text: '</system-reminder>\n\nplease audit' },
	];
	assert.equal(contentText(content), '<system-reminder>\nYou are teammate "audit-parser".\n</system-reminder>\n\nplease audit');
	assert.equal(teammateNameFromMessages([{ content }]), 'audit-parser');
	assert.equal(
		teammateNameFromMessages([{ content: [{ type: 'text', text: 'unrelated' }] }]),
		undefined,
	);
	assert.equal(teammateNameFromMessages([]), undefined);
	assert.equal(teammateNameFromMessages(undefined), undefined);
});

await check('either context can be claimed, and only one is recorded', async () => {
	const store = new PendingRouteStore(60_000, () => {});
	const route = { provider: 'p', model: 'm' };
	store.record('lead-1', 'audit-parser', 'fork', route);
	assert.deepEqual(store.claim('lead-1', 'audit-parser', 'fresh'), undefined);
	assert.deepEqual(store.claim('lead-1', 'audit-parser', 'fork'), route);
	// A claimed route is gone: the fresh probe must not resurrect it.
	assert.deepEqual(store.claim('lead-1', 'audit-parser', 'fresh'), undefined);
	assert.deepEqual(store.claim('lead-1', 'audit-parser', 'fork'), undefined);
});

console.log(results.join('\n'));
console.log(
	process.exitCode === 1
		? `\n${results.filter((line) => line.startsWith('FAIL')).length} check(s) failed`
		: `\nall ${results.length} checks passed`,
);
