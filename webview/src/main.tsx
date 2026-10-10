import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/nodes.css';
import './styles/panels.css';
import './styles/dialogs.css';
import 'highlight.js/styles/github-dark.css';

createRoot(document.getElementById('root')!).render(<App />);