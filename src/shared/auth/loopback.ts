import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface LoopbackResult {
  code: string;
  state: string;
}

export function waitForLoopbackCode(input: {
  redirectUri: string;
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LoopbackResult> {
  const redirect = new URL(input.redirectUri);
  const port = Number(redirect.port);
  if (!port || redirect.hostname !== '127.0.0.1') {
    return Promise.reject(new Error('The redirect URI must be http://127.0.0.1:<port>/<path>.'));
  }
  return listenForLoopback({
    port,
    pathname: redirect.pathname,
    expectedState: input.expectedState,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  }).then((loop) => loop.result);
}

export function beginLoopback(input: {
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  port?: number;
}): Promise<{ redirectUri: string; result: Promise<LoopbackResult> }> {
  return listenForLoopback({
    port: input.port ?? 0,
    pathname: '/callback',
    expectedState: input.expectedState,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

function listenForLoopback(input: {
  port: number;
  pathname: string;
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ redirectUri: string; result: Promise<LoopbackResult> }> {
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let listening = false;
    let resultResolve: (value: LoopbackResult) => void = () => undefined;
    let resultReject: (error: Error) => void = () => undefined;
    const result = new Promise<LoopbackResult>((res, rej) => {
      resultResolve = res;
      resultReject = rej;
    });
    const finish = (error: Error | null, value?: LoopbackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      const done = () => {
        if (error) resultReject(error);
        else if (value) resultResolve(value);
      };
      server.close(() => done());
    };
    const onAbort = () => finish(new Error('Sign-in was cancelled.'));
    const server: Server = createServer((request, response) => {
      handleLoopback(request, response, input.pathname, input.expectedState, finish);
    });
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in.')), timeoutMs);
    input.signal?.addEventListener('abort', onAbort);
    server.on('error', (error) => {
      if (!listening) reject(error);
      else finish(error);
    });
    server.listen(input.port, '127.0.0.1', () => {
      listening = true;
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}${input.pathname}`;
      resolve({ redirectUri, result });
    });
  });
}

function handleLoopback(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  expectedState: string,
  finish: (error: Error | null, value?: LoopbackResult) => void,
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== pathname) {
    response.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
    response.end('Not found');
    return;
  }
  const error = url.searchParams.get('error_description') || url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (error) {
    reply(response, 400, '<p>Sign-in failed. You can close this window.</p>', () => finish(new Error(error)));
    return;
  }
  if (!code || !state || state !== expectedState) {
    reply(response, 400, '<p>Sign-in could not be verified. You can close this window.</p>', () =>
      finish(new Error('The sign-in response failed the state check.')),
    );
    return;
  }
  reply(response, 200, '<p>Sign-in complete. You can close this window and return to the app.</p>', () =>
    finish(null, { code, state }),
  );
}

function reply(response: ServerResponse, status: number, body: string, done: () => void): void {
  response.writeHead(status, { 'Content-Type': 'text/html', Connection: 'close' });
  response.end(body, () => done());
}
