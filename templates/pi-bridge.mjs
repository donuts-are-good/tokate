import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { findPackageJSON } from 'node:module';

const [mode, cwd, modelId, commandNetwork, sentinel] = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const sdkPath = '/tokate-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
for (const name of ['pi-coding-agent', 'pi-ai', 'pi-agent-core']) {
    const packagePath = findPackageJSON(`@earendil-works/${name}`, `file://${sdkPath}`);
    if (!packagePath?.startsWith('/tokate-runtime/node_modules/')) throw new Error('Unsupported dependency layout');
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
    if (metadata.name !== `@earendil-works/${name}` || metadata.version !== '1.0.0') throw new Error('Untested pi dependency version');
}
const sdk = await import(sdkPath);
for (const name of ['createAgentSession', 'createExtensionRuntime', 'createReadToolDefinition', 'createEditToolDefinition', 'createWriteToolDefinition', 'createBashToolDefinition']) {
    if (typeof sdk[name] !== 'function') throw new Error('Unsupported pi SDK interface');
}
for (const [name, member] of [['ModelRuntime', 'create'], ['SessionManager', 'inMemory'], ['SettingsManager', 'inMemory']]) {
    if (typeof sdk[name]?.[member] !== 'function') throw new Error('Unsupported nested pi SDK interface');
}
if (process.version !== 'v26.10.0') throw new Error('Untested Node runtime');

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
            '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp/tokate-home', '--setenv', 'TMPDIR', '/tmp/tokate-home',
            '--setenv', 'LANG', 'C.UTF-8', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/tokate-home', '--bind', cwd, cwd, '--tmpfs', `${cwd}/.git`, '--chmod', '000', `${cwd}/.git`,
            '--tmpfs', '/tokate-control', '--chmod', '000', '/tokate-control', '--chdir', cwd];
        if (commandNetwork !== 'true') args.push('--unshare-net');
        args.push('--', '/bin/bash', '--noprofile', '--norc', '-c', command);
        const child = spawn('/usr/bin/bwrap', args, { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
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
if (!model || model.id !== modelId || model.provider !== 'tokate-local' || model.api !== 'openai-completions' || model.reasoning !== false) {
    throw new Error('Exact model unavailable; no fallback');
}
const customTools = [sdk.createReadToolDefinition(cwd, { operations: files, autoResizeImages: false }),
    sdk.createEditToolDefinition(cwd, { operations: files }), sdk.createWriteToolDefinition(cwd, { operations: files }),
    sdk.createBashToolDefinition(cwd, { operations: shell, exposeSessionEnvironment: false })];
const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/tmp/tokate-agent', model, thinkingLevel: 'off',
    scopedModels: [{ model, thinkingLevel: 'off' }], modelRuntime: runtime, resourceLoader: resources, tools: ['read', 'edit', 'write', 'bash'], customTools,
    sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        blockImages: true, cacheWarming: "off", defaultTools: ['read', 'edit', 'write', 'bash'],
    }) });
try {
    if (typeof session.getToolDefinition !== 'function' || typeof session.getActiveToolNames !== 'function' ||
        session.getActiveToolNames().sort().join(',') !== 'bash,edit,read,write' ||
        customTools.some(tool => session.getToolDefinition(tool.name) !== tool)) throw new Error('Unconstrained execution surface');
    if (modelFallbackMessage || session.model?.id !== modelId || session.model?.provider !== 'tokate-local') throw new Error('Pi substituted selection');
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
        emit({ type: 'pi.probe', version: '1.0.0', node: process.version });
    } else if (mode === 'run') {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) throw new Error('Task input exceeds limit');
            chunks.push(chunk);
        }
        emit({ type: 'pi.started', model: modelId, provider: 'local-chat-completions', effort: 'absent' });
        let ended = 0;
        let failed = false;
        let report = '';
        const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
        session.subscribe(event => {
            if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
                emit({ type: 'pi.event', event: event.type, tool: event.toolName, args: event.args, result: event.result, is_error: event.isError });
            }
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const message = event.message;
                if (message.model !== modelId || message.provider !== 'tokate-local') failed = true;
                if (!['stop', 'toolUse'].includes(message.stopReason)) failed = true;
                if (message.stopReason === 'stop') report = message.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
                for (const [target, source] of [['input_tokens', 'input'], ['cached_input_tokens', 'cacheRead'], ['output_tokens', 'output']]) {
                    const count = message.usage?.[source];
                    if (!Number.isSafeInteger(count) || count < 0) failed = true;
                    else usage[target] += count;
                }
                emit({ type: 'pi.event', event: 'assistant_end', stop_reason: message.stopReason, model: message.model, response_model: message.responseModel ?? null, usage: message.usage });
            }
            if (event.type === 'agent_end') ended++;
        });
        await session.prompt(Buffer.concat(chunks).toString('utf8'));
        if (ended !== 1 || failed || !report.trim() || session.model?.id !== modelId) throw new Error('Failed or incomplete pi turn');
        emit({ type: 'pi.completed', model: modelId, stop_reason: 'stop', report, usage });
    } else throw new Error('Unsupported bridge operation');
} finally {
    session.dispose();
}
