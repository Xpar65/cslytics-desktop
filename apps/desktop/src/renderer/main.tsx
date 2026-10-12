import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { startAppearance } from './lib/appearance.js';
import './app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Renderer root element is missing');

// The theme first, so the first frame is already in the chosen colours (lib/appearance.ts).
void startAppearance().then(() => {
  createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
});
