import type { AgentBridge } from '@shared/types';

declare global {
  interface Window {
    agent: AgentBridge;
    _pingOneSignals?: {
      init(options?: Record<string, unknown>): Promise<void>;
      getData(): Promise<string>;
    };
    _pingOneSignalsReady?: boolean;
  }
}

export {};
