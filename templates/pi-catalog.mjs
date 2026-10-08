try {
    let endpoint = '';
    for await (const chunk of process.stdin) {
        endpoint += chunk;
        if (endpoint.length > 4096) throw new Error();
    }
    const response = await fetch(`${endpoint}/models`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
    });
    const limit = 1024 * 1024;
    if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) throw new Error();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error();
        chunks.push(chunk);
    }
    process.stdout.write(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
} catch {
    process.exit(1);
}
