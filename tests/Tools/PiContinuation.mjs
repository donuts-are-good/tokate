import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VERSION = 'fixture-continuation';
export const createExtensionRuntime = () => ({});
export const SessionManager = { inMemory: () => ({}) };
export const SettingsManager = { inMemory: value => value };
export const ModelRuntime = {
    async create(options) {
        const location = options.modelsPath ?? path.join(process.env.PI_CODING_AGENT_DIR, 'models.json');
        const data = JSON.parse(await readFile(location, 'utf8'));
        const models = Object.entries(data.providers).flatMap(([provider, config]) =>
            config.models.map(model => ({ ...config, ...model, provider })));
        return {
            getError: () => undefined,
            getModels: () => models,
            getModel: (provider, id) => models.find(model => model.provider === provider && model.id === id),
        };
    },
};
export const createReadToolDefinition = () => ({ name: 'read' });
export const createWriteToolDefinition = () => ({ name: 'write' });
export const createBashToolDefinition = () => ({ name: 'bash' });
export const createEditToolDefinition = (cwd, { operations }) => ({
    name: 'edit',
    async execute(id, { path: relative, edits }) {
        const filename = path.join(cwd, relative);
        let text = String(await operations.readFile(filename));
        for (const edit of edits) text = text.replace(edit.oldText, edit.newText);
        await operations.writeFile(filename, text);
    },
});
export async function createAgentSession({ cwd, model, thinkingLevel, customTools }) {
    let observer;
    const session = {
        model,
        thinkingLevel,
        agent: { finishTurn: async () => ({ action: 'end' }), prepareRequest: async request => request },
        getToolDefinition: name => customTools.find(tool => tool.name === name),
        getActiveToolNames: () => customTools.map(tool => tool.name),
        getSessionStats: () => ({ tokens: { input: 100, cacheRead: 0, output: 10 } }),
        setAutoCompactionEnabled() {},
        steer: async () => 'queued',
        subscribe: listener => { observer = listener; },
        dispose() {},
        async prompt(prompt) {
            observer({ type: 'tool_execution_start', toolName: 'write', args: { prompt } });
            const interrupted = !prompt.startsWith('This is a fresh v2 attempt seeded from unpublished interrupted work.');
            await writeFile(path.join(cwd, 'tracked.txt'), 'preserved\n');
            await writeFile(path.join(cwd, 'imported.txt'), 'untracked\n');
            if (interrupted) {
                await mkdir(path.join(cwd, '.verification-data'), { recursive: true });
                await writeFile(path.join(cwd, '.verification-data/source-only'), 'Preserved source fixture output.');
                await new Promise(resolve => setTimeout(resolve, 120000));
            }
            await writeFile(path.join(cwd, 'result.txt'), 'Completed Pi continuation fixture\n');
            await writeFile(path.join(cwd, 'tokate-public-summary.json'), JSON.stringify({
                changes: ['Add a completed deterministic Pi fixture result.'], verification: [], limitations: [],
            }));
            observer({ type: 'message_end', message: {
                role: 'assistant', model: model.id, provider: model.provider, stopReason: 'stop',
                usage: { input: 100, cacheRead: 0, output: 10 },
                content: [{ type: 'text', text: 'Completed deterministic Pi coding turn.' }],
            } });
            observer({ type: 'agent_end' });
        },
    };
    return { session };
}
