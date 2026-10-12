import { createServer, type Server } from 'node:http';

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
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result?: LoopbackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      server.close();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onAbort = () => finish(new Error('Sign-in was cancelled.'));

    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', input.redirectUri);
      if (url.pathname !== redirect.pathname) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<p>Sign-in failed. You can close this window.</p>');
        finish(new Error(error));
        return;
      }
      if (!code || !state || state !== input.expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<p>Sign-in could not be verified. You can close this window.</p>');
        finish(new Error('The sign-in response failed the state check.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<p>Sign-in complete. You can close this window and return to the app.</p>');
      finish(null, { code, state });
    });

    const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in.')), timeoutMs);
    input.signal?.addEventListener('abort', onAbort);
    server.on('error', (error) => finish(error));
    server.listen(port, '127.0.0.1');
  });
}
