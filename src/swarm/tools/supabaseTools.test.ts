import { describe, it, expect, vi, afterEach } from 'vitest';
import { dueloddsSupabaseLookupTool } from './supabaseTools.ts';

describe('duelodds_supabase_lookup tool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports not configured', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const out: any = await dueloddsSupabaseLookupTool.execute({});
    expect(out.configured).toBe(false);
    expect(out.error).toBe('supabase_not_configured');
  });

  it('surfaces unfiltered_refused', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://mock.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 's');
    const out: any = await dueloddsSupabaseLookupTool.execute({});
    expect(out.configured).toBe(true);
    expect(out.error).toBe('unfiltered_refused');
  });
});
