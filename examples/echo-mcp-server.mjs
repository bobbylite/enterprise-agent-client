/**
 * Minimal stdio MCP server used by the sample config and tests.
 * Speaks newline-delimited JSON-RPC and the legacy initialize handshake.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const tools = [
  {
    name: 'echo',
    description: 'Returns the message it was given. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo.' },
      },
      required: ['message'],
    },
    annotations: { readOnlyHint: true },
  },
];

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return;
  }
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '0.1.0' },
      },
    });
    return;
  }

  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }

  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name !== 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
          isError: true,
        },
      });
      return;
    }
    const text = typeof args.message === 'string' ? args.message : '';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }], isError: false },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  });
});
