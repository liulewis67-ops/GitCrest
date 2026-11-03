import React from 'react';
import { createRoot } from 'react-dom/client';
import { installDemoEnvironment } from './demo-environment';
import '../src/styles/globals.css';

// Set up the isolated browser environment before importing any app stores.
installDemoEnvironment(window);
const [{ default: App }, { setLocale }, { startAppearance }] = await Promise.all([
  import('../src/app/App'),
  import('../src/shared/i18n'),
  import('../src/features/settings'),
]);
setLocale(new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh');
startAppearance();
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
