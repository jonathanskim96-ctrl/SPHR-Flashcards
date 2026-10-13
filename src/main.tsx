import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bustFrame, type FrameWindow } from './frameBust';
import { registerServiceWorker } from './pwa';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const framed = bustFrame(window as unknown as FrameWindow, () => {
  document.documentElement.hidden = true;
});

if (!framed) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  if (import.meta.env.PROD) void registerServiceWorker();
}
