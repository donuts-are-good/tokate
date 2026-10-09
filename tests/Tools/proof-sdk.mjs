import { readFileSync } from 'node:fs';
import http from 'node:http';

export const VERSION = 'fixture';
export class Settings {
    static async init() { return {}; }
}
export class AuthStorage {
    static async create() { return { close() {} }; }
}
export class ModelRegistry {
    constructor(auth, path) {
        this.config = JSON.parse(readFileSync(path));
    }
    getError() { return null; }
    getProviderModels(provider) {
        const config = this.config.providers[provider];
        return config.models.map(model => ({
            ...model, provider, api: config.api, baseUrl: config.baseUrl,
        }));
    }
}
export class SessionManager {
    static inMemory() { return {}; }
}

export async function createAgentSession(options) {
    const listeners = [];
    const session = {
        model: options.model,
        isStreaming: false,
        isAborting: false,
        agent: {
            state: { messages: [] },
            setRawSseEventInterceptor() {},
            async streamFn(model, context, options) {
                const request = () => options.fetch(model.baseUrl + '/chat/completions', {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer synthetic-never-valid',
                        'content-type': 'application/json',
                        'user-agent': 'omp/fixture',
                    },
                    body: JSON.stringify({
                        model: model.id, reasoning_effort: 'high', max_tokens: model.maxTokens,
                    }),
                });
                await request();
                if (process.env.PROOF_FAULT === 'transport') {
                    try { await request(); } catch {}
                }
            },
        },
        getActiveToolNames() { return ['read', 'write', 'edit', 'bash']; },
        getToolByName() {},
        subscribe(listener) { listeners.push(listener); },
        async prompt() {
            const count = process.env.PROOF_FAULT === 'dispatch' ? 2 : 1;
            for (let index = 0; index < count; index++) {
                try { await this.agent.streamFn(this.model, {}, {}); } catch {}
            }
            for (const listener of listeners) listener({ type: 'agent_end' });
        },
        async waitForIdle() {},
        async dispose() {
            if (process.env.PROOF_FAULT === 'dispose') {
                try { await this.agent.streamFn(this.model, {}, {}); } catch {}
            }
        },
    };
    return { session };
}

globalThis.Bun = {
    version: 'fixture',
    serve({ fetch }) {
        const server = http.createServer(async (incoming, outgoing) => {
            const chunks = [];
            for await (const chunk of incoming) chunks.push(chunk);
            const request = new Request('http://127.0.0.1:17777' + incoming.url, {
                method: incoming.method,
                headers: incoming.headers,
                body: Buffer.concat(chunks),
                duplex: 'half',
            });
            const response = await fetch(request);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        });
        server.listen(17777, '127.0.0.1');
        return {
            port: 17777,
            stop() {
                server.closeAllConnections();
                server.close();
            },
        };
    },
};
