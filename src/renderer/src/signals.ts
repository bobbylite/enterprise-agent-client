import type { AppState } from '@shared/types';

function whenReady(): Promise<void> {
  if (window._pingOneSignalsReady && window._pingOneSignals) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('PingOneSignalsReadyEvent', () => resolve(), { once: true });
  });
}

export async function collectProtectSignals(mode: AppState['mode']): Promise<string> {
  if (mode !== 'pingone') return '';
  try {
    await import('@ping-identity/pingone-signals-web-sdk');
    await whenReady();
    if (!window._pingOneSignals) return '';
    await window._pingOneSignals.init({});
    const data = await window._pingOneSignals.getData();
    return typeof data === 'string' ? data : '';
  } catch {
    return '';
  }
}
