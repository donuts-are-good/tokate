import path from "node:path";
import { pathToFileURL } from "node:url";

function endpoint(value) {
    try {
        return new URL(value).href.replace(/\/+$/, "");
    } catch {
        return "";
    }
}

try {
    const [root, id] = process.argv.slice(2);
    let selectedEndpoint = '';
    for await (const chunk of process.stdin) {
        selectedEndpoint += chunk;
        if (selectedEndpoint.length > 4096) throw new Error();
    }
    const sdkPath = path.join(root, "@earendil-works/pi-coding-agent/dist/index.js");
    const { ModelRuntime } = await import(pathToFileURL(sdkPath).href);
    const runtime = await ModelRuntime.create({
        credentials: { read: async () => undefined, list: async () => [] },
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    if (runtime.getError()) throw new Error();
    const models = runtime.getModels().filter(model => model.id === id && model.api === "openai-completions" && endpoint(model.baseUrl) === endpoint(selectedEndpoint));
    if (models.length !== 1) throw new Error();
    const model = models[0];
    const { contextWindow, maxTokens, reasoning } = model;
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error();
    if (typeof reasoning !== 'boolean') throw new Error();
    const thinkingLevelMap = {};
    const compat = { supportsReasoningEffort: false, thinkingFormat: 'openai' };
    let efforts = ['absent'];
    if (reasoning) {
        const { getSupportedThinkingLevels } = await import(import.meta.resolve('@earendil-works/pi-ai/compat', pathToFileURL(sdkPath).href));
        const format = model.compat?.thinkingFormat ?? 'openai';
        if (!['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template', 'string-thinking', 'ant-ling'].includes(format)) throw new Error();
        if (format === 'openai' && model.compat?.supportsReasoningEffort === false) throw new Error();
        compat.thinkingFormat = format;
        compat.supportsReasoningEffort = model.compat?.supportsReasoningEffort ?? true;
        for (const [level, value] of Object.entries(model.thinkingLevelMap ?? {})) {
            if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level) ||
                (value !== null && (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value)))) throw new Error();
            thinkingLevelMap[level] = value;
        }
        efforts = getSupportedThinkingLevels(model).filter(level => level !== 'off');
        if (!efforts.length) throw new Error();
    }
    process.stdout.write(JSON.stringify({ contextWindow, maxTokens, reasoning, thinkingLevelMap, compat, efforts }) + "\n");
} catch {
    process.exitCode = 1;
}
