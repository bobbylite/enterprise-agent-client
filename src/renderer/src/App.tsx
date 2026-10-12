import { useEffect, useState } from 'react';
import type { AppState, Branding, BrandingColors } from '@shared/types';
import { LoginScreen } from './screens/LoginScreen';
import { Shell } from './screens/Shell';

function applyColors(colors: BrandingColors): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    const cssKey = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--${cssKey}`, value);
  }
}

export function App() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [nextBranding, nextState] = await Promise.all([window.agent.getBranding(), window.agent.getState()]);
        applyColors(nextBranding.colors);
        document.title = nextBranding.appName;
        setBranding(nextBranding);
        setState(nextState);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, []);

  if (error) {
    return (
      <main className="boot">
        <h1>Unable to open</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!branding || !state) return <main className="boot">Loading</main>;
  if (!state.session) {
    return <LoginScreen branding={branding} state={state} onState={setState} />;
  }
  return <Shell branding={branding} state={state} onState={setState} />;
}
