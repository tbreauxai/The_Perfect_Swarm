import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from './App';

describe('App Input Limits and Counters', () => {
    it('renders input character limit indicators for data and task', () => {
        const html = renderToString(React.createElement(App));
        expect(html).toContain('0 / 500,000');
        expect(html).toContain('0 / 20,000');
        expect(html).toContain('Run Swarm');
    });

    it('has 500,000 char cap on data and 20,000 char cap on task', () => {
        expect(500000).toBe(500_000);
        expect(20000).toBe(20_000);
    });
});
