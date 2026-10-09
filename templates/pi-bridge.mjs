import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';

const [mode, cwd, modelId, commandNetwork, sentinel, continueTruncated = 'false', effort = 'absent'] = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const bash = process.env.TOKATE_BASH;
const bwrap = process.env.TOKATE_BWRAP;
if (!bash?.startsWith('/') || !bwrap?.startsWith('/')) throw new Error('Missing command isolation tools');
const sdkPath = '/tokate-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const sdk = await import(sdkPath);
if (typeof sdk.VERSION !== 'string' || !sdk.VERSION) throw new Error('Missing pi SDK version');
for (const name of ['createAgentSession', 'createExtensionRuntime', 'createReadToolDefinition', 'createEditToolDefinition', 'createWriteToolDefinition', 'createBashToolDefinition']) {
    if (typeof sdk[name] !== 'function') throw new Error('Unsupported pi SDK interface');
}
for (const [name, member] of [['ModelRuntime', 'create'], ['SessionManager', 'inMemory'], ['SettingsManager', 'inMemory']]) {
    if (typeof sdk[name]?.[member] !== 'function') throw new Error('Unsupported nested pi SDK interface');
}

const withParent = async (path, operation, recursive = false) => {
    const absolute = resolve(path);
    const root = [cwd, '/tmp/tokate-tools'].find(root => absolute === root || absolute.startsWith(`${root}/`));
    if (!root) throw new Error('Tool path denied');
    const parts = absolute.slice(root.length).split('/').filter(Boolean);
    if (root === cwd && parts[0] === '.git') throw new Error('Tool path denied');
    const leaf = parts.pop() ?? '.';
    let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        for (const part of parts) {
            const next = `/proc/self/fd/${directory.fd}/${part}`;
            if (recursive) {
                try { await mkdir(next); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
            const opened = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            await directory.close();
            directory = opened;
        }
        return await operation(`/proc/self/fd/${directory.fd}/${leaf}`);
    } finally {
        await directory.close();
    }
};
const withFile = (path, flags, operation) => withParent(path, async target => {
    const file = await open(target, flags | constants.O_NOFOLLOW);
    try { return await operation(file); } finally { await file.close(); }
});
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const usageView = usage => {
    if (!usage || !validCount(usage.input) || !validCount(usage.output) || !validCount(usage.cacheRead)) return undefined;
    return { input_tokens: usage.input, cached_input_tokens: usage.cacheRead, output_tokens: usage.output };
};
const partialView = content => {
    const counts = { text: 0, thinking: 0, toolCall: 0, other: 0 };
    let textCharacters = 0;
    let thinkingCharacters = 0;
    let partialText = '';
    let partialBytes = 0;
    let truncated = false;
    for (const part of content) {
        const type = ['text', 'thinking', 'toolCall'].includes(part.type) ? part.type : 'other';
        counts[type]++;
        if (type === 'thinking') {
            for (const character of part.thinking ?? '') thinkingCharacters++;
        }
        if (type !== 'text') continue;
        for (const character of part.text ?? '') {
            textCharacters++;
            const bytes = Buffer.byteLength(character, 'utf8');
            if (truncated || partialBytes + bytes > 65536) truncated = true;
            else {
                partialText += character;
                partialBytes += bytes;
            }
        }
    }
    return { partial_text: partialText, partial_text_truncated: truncated, content_counts: counts,
        text_characters: textCharacters, thinking_characters: thinkingCharacters };
};
const files = {
    readFile: path => withFile(path, constants.O_RDONLY, file => file.readFile()),
    writeFile: (path, content) => withFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, file => file.writeFile(content, 'utf8')),
    access: path => withFile(path, constants.O_RDONLY, async () => {}),
    mkdir: path => withParent(path, async target => {
        try { await mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const directory = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close();
    }, true),
    detectImageMimeType: async () => undefined,
};

const shell = {
    exec: (command, directory, { onData, signal, timeout }) => new Promise((complete, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        if (directory !== cwd) return reject(new Error('Unexpected shell directory'));
        const args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--clearenv',
            '--setenv', 'PATH', process.env.PATH, '--setenv', 'HOME', '/tmp/tokate-home', '--setenv', 'TMPDIR', '/tmp/tokate-home',
            '--setenv', 'LANG', 'C.UTF-8', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/tokate-home', '--bind', cwd, cwd, '--tmpfs', `${cwd}/.git`, '--chmod', '000', `${cwd}/.git`,
            '--tmpfs', '/tokate-control', '--chmod', '000', '/tokate-control', '--chdir', cwd];
        if (commandNetwork !== 'true') args.push('--unshare-net');
        for (const key of ['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS']) {
            if (process.env[key]) args.push('--setenv', key, process.env[key]);
        }
        args.push('--', bash, '--noprofile', '--norc', '-c', command);
        const child = spawn(bwrap, args, { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
        let expired = false;
        const stop = () => child.kill('SIGKILL');
        const timer = timeout === undefined ? undefined : setTimeout(() => { expired = true; stop(); }, timeout * 1000);
        signal?.addEventListener('abort', stop, { once: true });
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            if (signal?.aborted) reject(new Error('aborted'));
            else if (expired) reject(new Error(`timeout:${timeout}`));
            else complete({ exitCode: code ?? 137 });
        });
    }),
};
const resources = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Implement the supplied approved task using read, edit, write and constrained bash. Return the requested report.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
};
await writeFile('/tmp/tokate-agent/auth.json', '{}');
const runtime = await sdk.ModelRuntime.create({ authPath: '/tmp/tokate-agent/auth.json', modelsPath: '/tokate-control/models.json',
    modelsStorePath: '/tmp/tokate-agent/models-store.json', allowModelNetwork: false, refreshOnCreate: false });
if (typeof runtime.getModel !== 'function') throw new Error('Unsupported ModelRuntime capability');
const model = runtime.getModel('tokate-local', modelId);
if (!model || model.id !== modelId || model.provider !== 'tokate-local' || model.api !== 'openai-completions') {
    throw new Error('Exact model unavailable; no fallback');
}
const thinkingLevel = effort === 'absent' ? 'off' : effort;
if (effort === 'absent' ? model.reasoning : !model.reasoning) throw new Error('Reasoning capability differs from selection');
const customTools = [sdk.createReadToolDefinition(cwd, { operations: files, autoResizeImages: false }),
    sdk.createEditToolDefinition(cwd, { operations: files }), sdk.createWriteToolDefinition(cwd, { operations: files }),
    sdk.createBashToolDefinition(cwd, { operations: shell, exposeSessionEnvironment: false })];
const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/tmp/tokate-agent', model, thinkingLevel,
    scopedModels: [{ model, thinkingLevel }], modelRuntime: runtime, resourceLoader: resources, tools: ['read', 'edit', 'write', 'bash'], customTools,
    sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: sdk.SettingsManager.inMemory({
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        blockImages: true, cacheWarming: "off", defaultTools: ['read', 'edit', 'write', 'bash'],
    }) });
try {
    if (typeof session.getToolDefinition !== 'function' || typeof session.getActiveToolNames !== 'function' ||
        typeof session.getSessionStats !== 'function' || typeof session.setAutoCompactionEnabled !== 'function' ||
        typeof session.steer !== 'function' || typeof session.agent?.finishTurn !== 'function' ||
        typeof session.agent?.prepareRequest !== 'function' ||
        session.getActiveToolNames().sort().join(',') !== 'bash,edit,read,write' ||
        customTools.some(tool => session.getToolDefinition(tool.name) !== tool)) throw new Error('Unconstrained execution surface');
    if (modelFallbackMessage || session.model?.id !== modelId || session.model?.provider !== 'tokate-local' || session.thinkingLevel !== thinkingLevel) throw new Error('Pi substituted selection');
    if (mode === 'probe') {
        let denied = 0;
        for (const path of [sentinel, `${cwd}/.git/config`, '/tokate-control/auth.json', '/tokate-control/models.json']) {
            try { await files.readFile(path); } catch { denied++; }
        }
        try { await readFile(sentinel); throw new Error('Outer boundary exposed sentinel'); } catch (error) {
            if (error.message === 'Outer boundary exposed sentinel') throw error;
        }
        if (denied !== 4) throw new Error('Tool isolation failed');
        await files.writeFile(`${cwd}/probe.txt`, 'before');
        await customTools[1].execute('probe-edit', { path: 'probe.txt', edits: [{ oldText: 'before', newText: 'after' }] });
        if (String(await files.readFile(`${cwd}/probe.txt`)) !== 'after') throw new Error('SDK edit contract failed');
        const result = await shell.exec('test ! -r .git/config && test ! -r /tokate-control/models.json && ! touch /usr/bin/tokate-pi-probe && touch probe-shell.txt', cwd,
            { onData: () => {}, timeout: 5 });
        if (result.exitCode !== 0) throw new Error('Nested shell isolation failed');
        emit({ type: 'pi.probe', version: sdk.VERSION, node: process.version });
    } else if (mode === 'run') {
        if (!['true', 'false'].includes(continueTruncated)) {
            throw new Error('Invalid continuation allowance');
        }
        const lengthContinuationLimit = continueTruncated === 'true' ? 1 : 0;
        let bytes = 0;
        const chunks = [];
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) throw new Error('Task input exceeds limit');
            chunks.push(chunk);
        }
        emit({ type: 'pi.started', model: modelId, provider: 'local-chat-completions', effort,
            length_continuation_limit: lengthContinuationLimit });
        let ended = 0;
        let failureReason;
        let report = '';
        let lastStopReason;
        let lengthContinuations = 0;
        const fail = reason => {
            failureReason ??= reason;
            session.setAutoCompactionEnabled(false);
        };
        const previousFinishTurn = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal) => {
            if (signal?.aborted) {
                fail('aborted');
                return { action: 'end' };
            }
            const decision = await previousFinishTurn.call(session.agent, turn, signal);
            if (signal?.aborted) fail('aborted');
            if (failureReason) return { action: 'end' };
            if (turn.message.stopReason !== 'length') return decision;
            if (decision?.action === 'end' || lengthContinuations >= lengthContinuationLimit) {
                fail('length');
                return { action: 'end' };
            }
            const queued = await session.steer('Continue the existing approved work and return a complete concise final report.');
            if (signal?.aborted) fail('aborted');
            else if (queued !== 'queued') fail('incomplete');
            if (failureReason) return { action: 'end' };
            lengthContinuations++;
            emit({ type: 'pi.event', event: 'length_continuation', count: lengthContinuations, limit: lengthContinuationLimit });
            return { action: 'continue' };
        };
        const previousPrepareRequest = session.agent.prepareRequest;
        const guardRequest = signal => {
            if (signal?.aborted) fail('aborted');
            if (failureReason) throw new Error('Pi execution stopped');
        };
        session.agent.prepareRequest = async (request, signal) => {
            guardRequest(signal);
            const update = await previousPrepareRequest.call(session.agent, request, signal);
            guardRequest(signal);
            const selected = update?.model ?? request.model;
            if (selected?.id !== modelId || selected?.provider !== 'tokate-local' || (update?.thinkingLevel ?? request.thinkingLevel) !== thinkingLevel) {
                fail('identity');
                guardRequest(signal);
            }
            return update;
        };
        session.subscribe(event => {
            if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
                emit({ type: 'pi.event', event: event.type, tool: event.toolName, args: event.args, result: event.result, is_error: event.isError });
            }
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const message = event.message;
                lastStopReason = message.stopReason;
                report = '';
                if (message.model !== modelId || message.provider !== 'tokate-local' ||
                    (message.responseModel != null && message.responseModel !== modelId)) fail('identity');
                else if (!['stop', 'toolUse', 'length'].includes(message.stopReason)) {
                    fail(['error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'incomplete');
                }
                if (!usageView(message.usage)) fail('usage');
                if (message.stopReason === 'stop' && message.model === modelId && message.provider === 'tokate-local') {
                    report = message.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
                    if (!report.trim()) fail('incomplete');
                }
                emit({ type: 'pi.event', event: 'assistant_end', stop_reason: message.stopReason, model: message.model,
                    provider: message.provider, response_model: message.responseModel ?? null, usage: message.usage,
                    text: message.content.filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0, 16384),
                    ...(message.stopReason === 'length' ? partialView(message.content) : {}) });
            }
            if (event.type === 'compaction_end') {
                const reason = ['threshold', 'overflow', 'manual'].includes(event.reason) ? event.reason : 'unknown';
                const usage = usageView(event.result?.usage);
                if (event.aborted) fail('aborted');
                else if (!event.result || reason === 'unknown') fail('compaction');
                else if (!usage) fail('usage');
                emit({ type: 'pi.event', event: 'compaction_end', reason, aborted: event.aborted === true,
                    willRetry: event.willRetry === true, ...(usage ? { usage } : {}) });
            }
            if (event.type === 'agent_end') {
                ended++;
                if (event.willRetry === true) fail('incomplete');
            }
        });
        try { await session.prompt(Buffer.concat(chunks).toString('utf8')); } catch { fail('error'); }
        if (ended !== 1) fail('incomplete');
        if (session.model?.id !== modelId || session.model?.provider !== 'tokate-local' || session.thinkingLevel !== thinkingLevel) fail('identity');
        if (lastStopReason !== 'stop' || !report.trim()) fail('incomplete');
        const usage = usageView(session.getSessionStats().tokens);
        if (!usage) fail('usage');
        if (failureReason) {
            emit({ type: 'pi.failed', reason: failureReason, length_continuations: lengthContinuations });
            process.exitCode = 1;
        } else emit({ type: 'pi.completed', model: modelId, stop_reason: 'stop', report, usage, length_continuations: lengthContinuations });
    } else throw new Error('Unsupported bridge operation');
} finally {
    session.dispose();
}
