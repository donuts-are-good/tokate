import { readFile, writeFile, mkdir } from 'node:fs/promises';

const [mode, cwd, outside] = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let stage = 'import';
const observations = {};
const check = (value, label) => {
    if (value) return;
    const error = new Error(label);
    error.name = 'OmpProofError';
    throw error;
};
try {
    const packageDir = '/tokate-runtime/node_modules/@oh-my-pi/pi-coding-agent';
    const metadata = JSON.parse(await readFile(`${packageDir}/package.json`, 'utf8'));
    const entry = metadata.exports?.['.']?.import;
    check(typeof entry === 'string' && entry.startsWith('./') && !entry.split('/').includes('..'), 'Missing normal installed SDK entry');
    const sdk = await import(`${packageDir}/${entry}`);
    const blockers = [];
    for (const name of ['createAgentSession', 'ModelRegistry', 'AuthStorage', 'Settings', 'SessionManager']) {
        check(typeof sdk[name] === 'function', `Missing supported SDK capability: ${name}`);
    }
    const agentDir = '/tmp/tokate-agent';
    await mkdir(agentDir, { recursive: true });
    stage = 'settings';
    const settings = await sdk.Settings.init({ cwd, agentDir, overrides: {
        'retry.enabled': false, 'retry.maxRetries': 0, 'retry.modelFallback': false,
        'retry.usageAwareFallback': false, 'retry.waitForUsageReset': false, 'retry.fallbackChains': {},
        'compaction.enabled': false, 'compaction.midTurnEnabled': false, 'compaction.idleEnabled': false,
        'contextPromotion.enabled': false, 'providers.cacheWarming': 'off', 'providers.openaiWebsockets': 'off',
        'providers.streamFirstEventTimeoutSeconds': 2, 'providers.streamIdleTimeoutSeconds': 2,
        'enabledProviders': ['tokate-proof'], 'enabledModels': ['tokate-proof/synthetic-exact'],
        'advisor.enabled': false, 'autolearn.enabled': false, 'ttsr.enabled': false,
        'prewalk.enabled': false, 'includeWorkspaceTree': false, 'images.describeForTextModels': false,
        'fetch.enabled': false, 'bash.direnv': 'off', 'bash.autoBackground.enabled': false,
        'async.enabled': false, 'shellMinimizer.enabled': false, 'edit.mode': 'replace',
        'edit.recoverInlineEdits': false, 'edit.autoRepair.enabled': false, 'edit.blackbox.enabled': false,
        'read.summarize.enabled': false, 'read.summarize.prose': false, 'tools.speculativeExecution.enabled': false,
        'launch.enabled': false, 'git.enabled': false, 'checkpoint.enabled': false, 'magicKeywords.enabled': false,
        'recap.enabled': false, 'images.blockImages': true,
    } });
    stage = 'auth';
    const auth = await sdk.AuthStorage.create(`${agentDir}/agent.db`);
    let received = 0;
    let unexpected = 0;
    let taskRequests = 0;
    let dispatches = 0;
    let intercepted = 0;
    let denied = 0;
    let phase = 'startup';
    const allowed = mode === 'tools' ? 5 : mode === 'network-tool' ? 2 : 1;
    const sse = chunks => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const chunk = (delta, finish = null, usage) => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1,
        model: 'synthetic-exact', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
    const toolChunk = (name, args) => chunk({ tool_calls: [{ index: 0, id: `fixture-${received}`,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/task-probe') { taskRequests++; return new Response('synthetic-task-route'); }
        if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
            unexpected++;
            return new Response('', { status: 404 });
        }
        received++;
        observations.requests = received;
        const body = await request.json();
        if (mode === 'error404' || mode === 'error401' || mode === 'error429' || mode === 'error503' || mode === 'effort-error') {
            const status = mode === 'effort-error' ? 400 : Number(mode.slice(5));
            return Response.json({ error: { message: mode === 'effort-error' ? 'Unsupported reasoning_effort high' : 'Synthetic error', type: 'invalid_request_error' } },
                { status, headers: { 'retry-after': '0' } });
        }
        if (mode === 'redirect') return new Response('', { status: 307, headers: { location: '/escape' } });
        if (mode === 'malformed') return new Response('data: {broken\n\n', { headers: { 'content-type': 'text/event-stream' } });
        if (mode === 'cancel' || mode === 'cleanup-cancel') {
            const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse([chunk({ content: 'partial' })]).replace('data: [DONE]\n\n', ''))); } });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        let chunks;
        if (mode === 'network-tool' && received === 1) chunks = [toolChunk('bash', { command: `curl --max-time 1 -fsS http://127.0.0.1:${server.port}/task-probe`, timeout: 3 }), chunk({}, 'tool_calls', usage)];
        else if (mode === 'tools' && received === 1) chunks = [toolChunk('write', { path: 'result.txt', content: 'before\n' }), chunk({}, 'tool_calls', usage)];
        else if (mode === 'tools' && received === 2) chunks = [toolChunk('read', { path: 'result.txt' }), chunk({}, 'tool_calls', usage)];
        else if (mode === 'tools' && received === 3) chunks = [toolChunk('edit', { path: 'result.txt', old_string: 'before', new_string: 'after' }), chunk({}, 'tool_calls', usage)];
        else if (mode === 'tools' && received === 4) chunks = [toolChunk('bash', { command: 'cat result.txt && printf command-drained', timeout: 3 }), chunk({}, 'tool_calls', usage)];
        else if (mode === 'empty') chunks = [chunk({}, 'stop', usage)];
        else if (mode === 'truncated-tool') chunks = [chunk({ tool_calls: [{ index: 0, id: 'broken', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }), chunk({}, 'length', usage)];
        else chunks = [chunk({ role: 'assistant', content: 'synthetic settled result' }), chunk({}, mode === 'length' ? 'length' : 'stop', mode === 'bad-usage' ? { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 } : mode === 'overflow-usage' ? { prompt_tokens: 10, completion_tokens: 5000, total_tokens: 5010 } : mode === 'missing-usage' ? undefined : usage)];
        let text = sse(chunks);
        if (mode === 'incomplete') text = sse([chunk({ content: 'partial' })]).replace('data: [DONE]\n\n', '');
        return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const modelConfig = { id: 'synthetic-exact', name: 'Synthetic', reasoning: true, input: ['text'],
        contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: true, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } };
    const configPath = `${agentDir}/models.json`;
    const configuration = { providers: { 'tokate-proof': { api: 'openai-completions', baseUrl, authHeader: false,
        apiKey: 'synthetic-never-valid', models: [modelConfig] } } };
    if (mode === 'missing') delete configuration.providers['tokate-proof'].models[0].contextWindow;
    if (mode === 'invalid') configuration.providers['tokate-proof'].models[0].maxTokens = -1;
    if (mode === 'unconfigured') configuration.providers = {};
    if (mode === 'ambiguous') configuration.providers['tokate-proof'].models.push({ ...modelConfig });
    await writeFile(configPath, JSON.stringify(configuration));
    let discoveryAttempts = 0;
    stage = 'metadata';
    const registry = new sdk.ModelRegistry(auth, configPath, { settings,
        fetch: async () => { discoveryAttempts++; throw new Error('Discovery networking refused'); } });
    const project = () => {
        check(!registry.getError(), 'Harness rejected synthetic configuration');
        const models = registry.getProviderModels('tokate-proof').filter(model => model.id === 'synthetic-exact');
        check(models.length === 1, 'Ambiguous or missing configured model');
        const model = models[0];
        const declared = configuration.providers['tokate-proof'].models;
        check(declared.length === 1 && Number.isSafeInteger(declared[0].contextWindow) && declared[0].contextWindow > 0 &&
            Number.isSafeInteger(declared[0].maxTokens) && declared[0].maxTokens > 0 && declared[0].maxTokens <= declared[0].contextWindow,
            'Exact finite limits must be explicitly configured');
        check(model.api === 'openai-completions' && model.provider === 'tokate-proof' && model.baseUrl === baseUrl && model.reasoning === true,
            'Model configuration changed');
        check(model.contextWindow === declared[0].contextWindow && model.maxTokens === declared[0].maxTokens,
            'Harness metadata lost configured limits');
        return model;
    };
    let session;
    try {
        if (['missing', 'invalid', 'ambiguous', 'unconfigured', 'unknown-settings'].includes(mode)) {
            let refused = false;
            try {
                if (mode === 'unknown-settings') sdk.Settings.isolated({ 'synthetic.unknownControl': true });
                else project();
            } catch { refused = true; }
            check(refused, 'Invalid configuration was accepted');
            check(received === 0 && discoveryAttempts === 0, 'Configuration validation spent a request');
            emit({ type: 'omp.proof', mode, package: sdk.VERSION, bun: Bun.version, refused: true, requests: 0, blockers: [] });
        } else {
            const model = project();
            const enforce = (input, init, budget) => {
                const request = new Request(input, init);
                check(phase === 'turn' && request.url === `${baseUrl}/chat/completions`, 'Unapproved transport URL');
                check(request.method === 'POST', 'Unapproved transport method');
                const allowedHeaders = new Set(['content-type', 'accept', 'x-stainless-timeout', 'user-agent', 'authorization']);
                check([...request.headers.keys()].every(name => allowedHeaders.has(name)), 'Unapproved transport header');
                check(request.headers.get('authorization') === 'Bearer synthetic-never-valid' && !request.headers.has('x-api-key'), 'Unexpected authentication header');
                if (budget.used) { denied++; throw new Error('Attempt already spent'); }
                budget.used = true;
                return request;
            };
            phase = 'turn';
            const validHeaders = { authorization: 'Bearer synthetic-never-valid', 'content-type': 'application/json' };
            enforce(`${baseUrl}/chat/completions`, { method: 'POST', headers: validHeaders }, { used: false });
            for (const [url, method, headers] of [[`${baseUrl}/other`, 'POST', {}], [`${baseUrl}/chat/completions?x=1`, 'POST', {}],
                [`${baseUrl}/chat/completions`, 'GET', {}], [`${baseUrl}/chat/completions`, 'POST', { authorization: 'synthetic' }]]) {
                let refused = false;
                try { enforce(url, { method, headers }, { used: false }); } catch { refused = true; }
                check(refused, 'Transport restriction failed');
            }
            phase = 'startup';
            stage = 'session';
            let commandHookCalls = 0;
            let commandFactoryCalls = 0;
            const commandRestriction = api => {
                commandFactoryCalls++;
                api.on('tool_call', event => {
                    if (event.toolName !== 'bash') return;
                    commandHookCalls++;
                    return { block: true, reason: 'Synthetic command restriction' };
                });
            };
            const created = await sdk.createAgentSession({ cwd, agentDir, settings, authStorage: auth, modelRegistry: registry,
                model, thinkingLevel: 'high', thinkingLevelCeiling: 'high', scopedModels: [{ model, thinkingLevel: 'high' }],
                sessionManager: sdk.SessionManager.inMemory(cwd), toolNames: ['read', 'write', 'edit', 'bash'], restrictToolNames: true,
                enableMCP: false, enableLsp: false, enableIrc: false, disableExtensionDiscovery: true,
                preloadedExtensionPaths: [], preloadedCustomToolPaths: [], skills: [], rules: [], contextFiles: [],
                promptTemplates: [], slashCommands: [], spawns: '', skipPythonPreflight: true, hasUI: false,
                cacheWarming: false, allowSessionModelFallback: false, settingsApproval: false, autoApprove: true,
                extensions: ['boundary', 'network-tool'].includes(mode) ? [commandRestriction] : [],
                systemPrompt: 'Use the four coding tools for this synthetic fixture only.', deadline: Date.now() + 15000 });
            session = created.session;
            const nativeStream = session.agent.streamFn;
            check(typeof nativeStream === 'function', 'Missing supported native stream hook');
            session.agent.streamFn = (selected, context, options) => {
                dispatches++;
                observations.dispatches = dispatches;
                check(phase === 'turn' && dispatches <= allowed && selected.id === model.id && selected.provider === model.provider,
                    'Unapproved auxiliary dispatch or fallback');
                const budget = { used: false };
                return nativeStream(selected, context, { ...options, fetch: async (input, init) => {
                    intercepted++;
                    observations.intercepted = intercepted;
                    try {
                        const request = enforce(input, init, budget);
                        check(request.headers.get('user-agent') === `omp/${sdk.VERSION}`, 'Unapproved user agent');
                        const body = JSON.parse(await request.clone().text());
                        check(body.model === model.id && body.reasoning_effort === 'high', 'Native selection changed');
                        check(body.max_tokens === model.maxTokens, 'Native output limit changed');
                        check(!body.fallbacks && !body.models && !body.service_tier, 'Unapproved spending option');
                        const response = await fetch(request, { redirect: 'manual' });
                        if (response.status >= 300 && response.status < 400) throw new Error('Provider redirect refused');
                        return response;
                    } catch (error) {
                        if (error.name === 'OmpProofError') observations.transport_assertion = error.message;
                        throw error;
                    }
                } });
            };
            check(!created.modelFallbackMessage && session.model.id === model.id && session.model.contextWindow === model.contextWindow &&
                session.model.maxTokens === model.maxTokens, 'Session substituted metadata');
            check(session.getActiveToolNames().sort().join(',') === 'bash,edit,read,write', 'Unrestricted native tool surface');
            for (const excluded of ['task', 'eval', 'web_search', 'security_scan', 'generate_image', 'lsp', 'github', 'checkpoint']) {
                check(!session.getToolByName(excluded), 'Unsupported surface exposed');
            }
            let rawUsageValid = true;
            let rawUsageCount = 0;
            session.agent.setRawSseEventInterceptor(event => {
                if (event.data === '[DONE]') return;
                let frame;
                try { frame = JSON.parse(event.data); } catch { rawUsageValid = false; return; }
                if (!frame.usage) return;
                rawUsageCount++;
                const u = frame.usage;
                rawUsageValid &&= Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0 && u.prompt_tokens <= model.contextWindow &&
                    Number.isSafeInteger(u.completion_tokens) && u.completion_tokens >= 0 && u.completion_tokens <= model.maxTokens &&
                    Number.isSafeInteger(u.total_tokens) && u.total_tokens === u.prompt_tokens + u.completion_tokens;
            });
            const execute = (name, args, signal, update) => session.getToolByName(name).execute('direct', args, signal, update);
            const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
            stage = 'tools';
            if (mode === 'boundary') {
                await execute('write', { path: 'direct.txt', content: 'native write\n' });
                check((await readFile(`${cwd}/direct.txt`, 'utf8')) === 'native write\n', 'Native write failed');
                check(text(await execute('read', { path: 'direct.txt' })).includes('native write'), 'Native direct read failed');
                check(text(await execute('read', { path: 'large.txt:5000-5002' })).includes('line-5000'), 'Native streamed read failed');
                check(text(await execute('read', { path: 'helper.json?q=.value&raw=1' })).includes('native-helper'), 'Native JSON helper failed');
                for (const path of [outside, `${cwd}/.git/config`, `${cwd}/escape`, 'file://' + outside, `${outside}.json?q=.value&raw=1`]) {
                    let exposed = false;
                    try { exposed = text(await execute('read', { path })).includes('synthetic-private-sentinel'); } catch { }
                    check(!exposed, 'Native read escaped the OS boundary');
                    try { await execute('write', { path, content: 'escaped' }); } catch { }
                    try { await execute('edit', { path, old_string: 'synthetic-private-sentinel', new_string: 'escaped' }); } catch { }
                }
                const command = `cat direct.txt && printf '\\ncommand-drained\\n'`;
                for (const path of [outside, `${outside}.json`, '.git/config', 'escape']) {
                    const deniedRead = text(await execute('bash', { command: `cat '${path}'`, timeout: 3 }));
                    check(!deniedRead.includes('synthetic-private-sentinel'), 'Native command read escaped the OS boundary');
                }
                let updates = 0;
                const commandResult = await execute('bash', { command, timeout: 5 }, undefined, () => updates++);
                const output = text(commandResult);
                observations.command_exit = commandResult.details?.exitCode;
                observations.command_error = commandResult.isError;
                observations.command_result = { nativeWrite: output.includes('native write'), drained: output.includes('command-drained'), updates };
                check(output.includes('native write') && output.includes('command-drained'), 'Native command boundary or drain failed');
                let urlRefused = false;
                try { await execute('read', { path: `${baseUrl}/models` }); } catch { urlRefused = true; }
                check(urlRefused && unexpected === 0 && received === 0, 'Native URL reads bypassed task networking');
                const curl = text(await execute('bash', { command: `curl --max-time 1 -fsS http://127.0.0.1:${server.port}/task-probe`, timeout: 3 }));
                if (curl.includes('synthetic-task-route')) blockers.push('Native embedded bash can reach the inference loopback namespace with task networking disabled.');
                if (commandFactoryCalls === 0) blockers.push('Restricted SDK sessions ignore the public inline extension command interception hook.');
                const external = text(await execute('bash', { command: "python3 -c 'import socket; s=socket.socket(); s.settimeout(0.5); print(\"external-route-refused\" if s.connect_ex((\"192.0.2.1\",80)) else \"unexpected-route\")'", timeout: 3 }));
                check(external.includes('external-route-refused'), 'Unexpected external task route');
                emit({ type: 'omp.proof', mode, package: sdk.VERSION, bun: Bun.version, contextWindow: model.contextWindow,
                    maxTokens: model.maxTokens, requests: received, discoveryAttempts, updates, commandFactoryCalls, commandHookCalls, blockers });
            } else if (mode === 'unsupported') {
                for (const extra of [{ async: true }, { name: 'synthetic-service' }]) {
                    let refused = false;
                    try { await execute('bash', { command: 'touch unsupported-surface', ...extra }); } catch { refused = true; }
                    check(refused && !(await Bun.file(`${cwd}/unsupported-surface`).exists()), 'Unsupported service or async execution did not fail closed');
                }
                await execute('bash', { command: 'touch pty-fallback', pty: true, timeout: 3 });
                if (await Bun.file(`${cwd}/pty-fallback`).exists()) blockers.push('Native bash silently falls back to embedded execution for unsupported PTY requests.');
                emit({ type: 'omp.proof', mode, package: sdk.VERSION, bun: Bun.version, requests: received, blockers });
            } else if (mode.startsWith('command-')) {
                const controller = new AbortController();
                let updates = 0;
                const started = Date.now();
                const operation = execute('bash', { command: `python3 descendant.py '${cwd}' && printf command-started && sleep 30 && touch forbidden-completion`,
                    timeout: mode === 'command-timeout' ? 1 : 5 }, controller.signal, () => updates++).catch(() => undefined);
                const deadline = Date.now() + 2000;
                while (!(await Bun.file(`${cwd}/descendant-ready`).exists())) {
                    check(Date.now() < deadline, 'Command descendant did not acknowledge readiness');
                    await Bun.sleep(10);
                }
                await Bun.sleep(100);
                if (mode === 'command-cancel') controller.abort();
                await operation;
                check(Date.now() - started < 4000 && updates > 0 && !(await Bun.file(`${cwd}/forbidden-completion`).exists()), 'Native command interruption or output drain failed');
                check(received === 0 && discoveryAttempts === 0, 'Command interruption spent a request');
                await session.dispose();
                session = undefined;
                emit({ type: 'omp.proof', mode, package: sdk.VERSION, bun: Bun.version, requests: 0, updates,
                    disposed: true, completion_candidate: false, blockers });
            } else {
                if (mode.startsWith('cleanup-')) {
                    await execute('bash', { command: `python3 descendant.py '${cwd}'`, timeout: 3 });
                    const deadline = Date.now() + 2000;
                    while (true) {
                        try { await readFile(`${cwd}/descendant-ready`); break; } catch { }
                        check(Date.now() < deadline, 'Detached descendant did not acknowledge readiness');
                        await Bun.sleep(10);
                    }
                }
                let ended = 0;
                let toolTurns = 0;
                session.subscribe(event => {
                    if (event.type === 'agent_end') ended++;
                    if (event.type === 'tool_execution_end') toolTurns++;
                });
                stage = 'turn';
                phase = 'turn';
                let cancel;
                if (mode === 'cancel' || mode === 'cleanup-cancel') cancel = setTimeout(() => { void session.abort(); }, 300);
                try { await session.prompt('Perform the synthetic fixture task.'); } finally { clearTimeout(cancel); }
                await session.waitForIdle();
                phase = 'settled';
                check(!session.isStreaming && !session.isAborting && ended > 0, 'Native session did not settle');
                check(received === allowed && unexpected === 0, 'Unapproved request, redirect or recovery');
                const assistants = session.agent.state.messages.filter(message => message.role === 'assistant');
                const last = assistants.at(-1);
                const goodUsage = last?.usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(field =>
                    Number.isSafeInteger(last.usage[field]) && last.usage[field] >= 0 && last.usage[field] <= model.contextWindow + model.maxTokens);
                if (mode === 'network-tool' && taskRequests > 0) blockers.push('Model-driven native bash reaches the inference loopback namespace with task networking disabled.');
                const complete = blockers.length === 0 && last?.stopReason === 'stop' && goodUsage && rawUsageValid && rawUsageCount === received && last.content.some(part => part.type === 'text' && part.text.trim());
                if (['stop', 'tools', 'cleanup-stop'].includes(mode)) {
                    check(complete, 'Successful native turn lacked final text or bounded usage');
                    const tokens = session.getSessionStats().tokens;
                    check(tokens.input === received * 10 && tokens.output === received * 5, 'Native usage omitted an attempt');
                    if (mode === 'tools') {
                        check(toolTurns === 4 && (await readFile(`${cwd}/result.txt`, 'utf8')) === 'after\n', 'Ordinary native tool turns failed');
                    }
                } else if (mode === 'network-tool' && blockers.length === 0) check(complete, 'Restricted command turn did not complete');
                else check(!complete, 'Failed or incomplete result fabricated completion');
                await session.dispose();
                session = undefined;
                emit({ type: 'omp.proof', mode, package: sdk.VERSION, bun: Bun.version, requests: received, dispatches, intercepted,
                    denied, discoveryAttempts, settled: true, disposed: true, completion_candidate: Boolean(complete), rawUsageValid, rawUsageCount, toolTurns,
                    taskRequests, commandFactoryCalls, commandHookCalls, blockers });
            }
            check(discoveryAttempts === 0, 'Unexpected model discovery');
        }
    } finally {
        phase = 'closed';
        if (session) await session.dispose();
        auth.close();
        server.stop(true);
    }

} catch (error) {
    emit({ type: 'omp.failure', mode, stage, observations, reason: error.name, ...(error.name === 'OmpProofError' ? { assertion: error.message } : {}) });
    process.exitCode = 1;
}
