import type { AgentTier, AgentTierRole, DomainTaxonomyNode } from './types.ts';

/**
 * Built-in Domain Taxonomy classifying technical specializations.
 */
export const DOMAIN_TAXONOMY: Record<string, DomainTaxonomyNode> = {
    security: {
        domain: 'Security & Compliance',
        subDomains: ['auth', 'cryptography', 'vulnerability', 'auditing', 'zero_trust'],
        coreKeywords: [
            'security', 'auth', 'token', 'jwt', 'vulnerability', 'cve', 'exploit',
            'injection', 'permission', 'credential', 'firewall', 'breach', 'tls',
            'ssl', 'oauth', 'acl', 'encryption', 'crypt', 'sanitize', 'audit', 'xss'
        ]
    },
    performance: {
        domain: 'Performance & Resource Systems',
        subDomains: ['latency', 'throughput', 'profiling', 'memory', 'cpu'],
        coreKeywords: [
            'performance', 'latency', 'slow', 'bottleneck', 'cpu', 'memory', 'ram',
            'leak', 'io_wait', 'gc_pause', 'throughput', 'profile', 'benchmark',
            'concurrency', 'saturation', 'queue_depth', 'overhead', 'contention'
        ]
    },
    database: {
        domain: 'Data Storage & Persistence',
        subDomains: ['sql', 'nosql', 'indexing', 'transactions', 'sharding'],
        coreKeywords: [
            'database', 'sql', 'postgres', 'query', 'nosql', 'index', 'lock',
            'deadlock', 'transaction', 'table', 'schema', 'migration', 'sharding',
            'replication', 'connection_pool', 'replica_lag', 'acid', 'qdrant'
        ]
    },
    infrastructure: {
        domain: 'Cloud Infrastructure & SRE',
        subDomains: ['kubernetes', 'networking', 'containers', 'observability'],
        coreKeywords: [
            'infra', 'infrastructure', 'cloud', 'kubernetes', 'k8s', 'docker',
            'container', 'pod', 'cluster', 'node', 'host', 'network', 'dns',
            'load_balancer', 'ingress', 'failover', 'devops', 'sre', 'aws', 'gcp'
        ]
    },
    software_engineering: {
        domain: 'Software Architecture & Design',
        subDomains: ['design_patterns', 'refactoring', 'testing', 'syntax'],
        coreKeywords: [
            'architecture', 'design', 'refactor', 'typescript', 'pattern', 'pipeline',
            'api', 'service', 'module', 'interface', 'syntax', 'bug', 'exception',
            'stack_trace', 'nullpointer', 'typeerror', 'test', 'clean_code'
        ]
    },
    general: {
        domain: 'General Analysis',
        subDomains: ['summary', 'triage'],
        coreKeywords: ['general', 'overview', 'summary', 'status', 'report', 'check']
    }
};

/**
 * Classifies an agent role into an AgentTier based on naming and capability patterns.
 */
export function classifyAgentTier(role: string): { tier: AgentTier; tierRole: AgentTierRole } {
    const r = role.toLowerCase();

    if (r.includes('manager') || r.includes('coordinator') || r.includes('orchestrator') || r.includes('director')) {
        return { tier: 0, tierRole: 'root_coordinator' };
    }
    if (r.includes('lead') || r.includes('architect') || r.includes('principal') || r.includes('head')) {
        return { tier: 1, tierRole: 'cluster_lead' };
    }
    if (r.includes('tool') || r.includes('operator') || r.includes('calculator') || r.includes('extractor') || r.includes('validator')) {
        return { tier: 3, tierRole: 'leaf_operator' };
    }
    // Default analysts, specialists, engineers are Tier 2 deep specialists
    return { tier: 2, tierRole: 'deep_specialist' };
}

function matchesKeyword(text: string, kw: string): boolean {
    if (text.includes(kw)) return true;
    if (kw.endsWith('y') && text.includes(kw.slice(0, -1) + 'ies')) return true;
    if (text.includes(kw + 's') || text.includes(kw + 'es')) return true;
    return false;
}

/**
 * Evaluates semantic affinity and returns the best matching primary domain from taxonomy.
 */
export function identifyPrimaryDomain(text: string): { domainKey: string; domainName: string; score: number; matchedKeywords: string[] } {
    const lower = text.toLowerCase();
    let bestKey = 'general';
    let bestCount = 0;
    let bestKeywords: string[] = [];

    for (const [key, node] of Object.entries(DOMAIN_TAXONOMY)) {
        if (key === 'general') continue;
        const matched = node.coreKeywords.filter(kw => matchesKeyword(lower, kw));
        if (matched.length > bestCount) {
            bestCount = matched.length;
            bestKey = key;
            bestKeywords = matched;
        }
    }

    const score = Math.min(1.0, bestCount > 0 ? (bestCount * 0.15) + 0.25 : 0.2);
    return {
        domainKey: bestKey,
        domainName: DOMAIN_TAXONOMY[bestKey].domain,
        score,
        matchedKeywords: bestKeywords
    };
}
