import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CortexDiagnosticsViewer } from './CortexDiagnosticsViewer';

describe('CortexDiagnosticsViewer - Calm 401 State & Error Handling', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('renders initial loading skeleton without crashing', () => {
        const html = renderToString(React.createElement(CortexDiagnosticsViewer));
        expect(html).toContain('Loading Cortex Diagnostics...');
    });
});
