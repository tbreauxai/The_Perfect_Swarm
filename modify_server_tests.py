import sys

def modify():
    with open("src/swarm/server.test.ts", "r") as f:
        content = f.read()

    search = """describe('Swarm Server & Feedback Attribution', () => {"""

    replace = """describe('Swarm Server & Feedback Attribution', () => {

    it('a workflow return does not block on the cortex upsert', async () => {
        let upsertStarted = false;
        let upsertFinished = false;

        const mockCortex = {
            store: async () => {
                upsertStarted = true;
                // Wait deliberately to ensure the caller didn't block
                await new Promise(resolve => setTimeout(resolve, 50));
                upsertFinished = true;
                return "mock-id";
            },
            isQdrantAvailable: false
        };

        const { runLearningPipeline } = await import('./engine/learningPipeline.ts');

        const res = await runLearningPipeline({
            task: 'test non blocking',
            data: null,
            finalAnalysis: { ui_title: 'test' },
            context: { addEvent: () => {} } as any,
            params: {} as any,
            settings: undefined,
            workflowStartTime: Date.now(),
            complexity: 'instant',
            workflowLifecycleResult: { success: true },
            analysts: [],
            managerAgent: { role: 'manager' } as any,
            memoryCortex: mockCortex as any,
            targetAppId: 'app1',
            cacheKey: 'k',
            cacheQuery: 'q',
            agentConfigVersion: 'v',
            tieredCacheEnabled: false,
            profilingEnabled: false,
            coordinationEnabled: false,
            workflowTotalTokens: 0,
            workflowPromptTokensSaved: 0,
            workflowOriginalPromptTokens: 0,
            workflowCompressedPromptTokens: 0,
            workflowDeduplicatedCount: 0
        });

        // The pipeline should return instantly without awaiting the store
        expect(upsertStarted).toBe(true);
        expect(upsertFinished).toBe(false); // Because it takes 50ms and we didn't block

        // Cleanup wait
        await new Promise(resolve => setTimeout(resolve, 60));
    });
"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/server.test.ts", "w") as f:
            f.write(content)
        print("Success server test")
    else:
        print("Search not found in server test")

modify()
