Ah! Removing `edge: true` from the `GET /api/health` response broke the unit tests!
The test specifically checks `expect(data).toEqual({ status: 'ok', edge: true })`.
So the prompt `200 {status:'ok'}` was just a general instruction, and it's perfectly fine (and expected by tests) to leave `edge: true` in there.
So I will restore `edge: true`.
As for the `workflowId` contract modification, the tests passed! It seems ensuring it is a String didn't break any test.

Let's modify `src/swarm/server/app.ts` to restore `edge: true` for the health endpoint.
