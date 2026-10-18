import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { startAppearance } from './lib/appearance.js';
import { startCurrency } from './lib/currency.js';
import './app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Renderer root element is missing');

// The theme first, so the first frame is already in the chosen colours (lib/appearance.ts), and
// the currency with it, so the first figure already carries the right code (lib/currency.ts).
void Promise.all([startAppearance(), startCurrency()]).then(() => {
  createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
});
