import React, { useEffect, useState } from 'react';
import { Database, Server, Folder, Shield, Activity, RefreshCw, Zap } from 'lucide-react';

interface CortexDiagnostics {
  qdrantAvailable: boolean;
  collectionName: string;
  pointCount: number;
  appCount: number;
  fallbackStoreSize: number;
  storageByDomain: Record<string, number>;
  storageByRole: Record<string, number>;
  latencyStats?: {
      mean: number;
      p95: number;
      p99: number;
  };
  cacheHitRatio?: number;
  modelSuggestions?: string;
}

export function CortexDiagnosticsViewer() {
  const [diagnostics, setDiagnostics] = useState<CortexDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch cortex diagnostics
      const res = await fetch('/api/swarm/cortex/diagnostics');
      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.statusText}`);
      }
      const data = await res.json();

      // Fetch speed/latency diagnostics via telemetry
      const metricsRes = await fetch('/api/swarm/metrics');
      let telemetryData: any = {};
      if (metricsRes.ok) {
        telemetryData = await metricsRes.json();
      }

      setDiagnostics({
        ...data,
        latencyStats: telemetryData.overallLatency,
        cacheHitRatio: telemetryData.cacheHitRatio
      });
    } catch (err: any) {
      setError(err.message || 'Error fetching diagnostics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiagnostics();
    const interval = setInterval(fetchDiagnostics, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  if (loading && !diagnostics) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 animate-pulse flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-neutral-500">Loading Cortex Diagnostics...</span>
      </div>
    );
  }

  if (error && !diagnostics) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-red-200 text-red-600 flex flex-col gap-2">
        <div className="font-semibold flex items-center gap-2">
          <Activity className="w-5 h-5" /> Cortex Diagnostics Error
        </div>
        <div className="text-sm">{error}</div>
        <button onClick={fetchDiagnostics} className="self-start mt-2 text-sm bg-red-50 px-3 py-1.5 rounded hover:bg-red-100 transition">
          Retry
        </button>
      </div>
    );
  }

  if (!diagnostics) return null;

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 space-y-6">
      <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
        <h2 className="text-xl font-medium flex items-center gap-2">
          <Database className="w-5 h-5 text-indigo-600" />
          Real-time Health Report
        </h2>
        <button
          onClick={fetchDiagnostics}
          disabled={loading}
          className="p-1.5 text-neutral-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
          title="Refresh Diagnostics"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 flex flex-col items-center text-center">
          <span className="text-xs font-medium text-neutral-500 mb-1 flex items-center gap-1">
            <Server className="w-3.5 h-3.5" /> Engine
          </span>
          <span className={`text-lg font-semibold ${diagnostics.qdrantAvailable ? 'text-emerald-600' : 'text-amber-600'}`}>
            {diagnostics.qdrantAvailable ? 'Qdrant' : 'In-Memory'}
          </span>
        </div>
        <div className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 flex flex-col items-center text-center">
          <span className="text-xs font-medium text-neutral-500 mb-1">Total Memories</span>
          <span className="text-xl font-semibold text-neutral-800">{diagnostics.pointCount.toLocaleString()}</span>
        </div>
        <div className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 flex flex-col items-center text-center">
          <span className="text-xs font-medium text-neutral-500 mb-1">Active Apps</span>
          <span className="text-xl font-semibold text-neutral-800">{diagnostics.appCount.toLocaleString()}</span>
        </div>
        <div className="bg-neutral-50 rounded-xl p-4 border border-neutral-100 flex flex-col items-center text-center">
          <span className="text-xs font-medium text-neutral-500 mb-1 flex items-center gap-1">
            <Zap className="w-3.5 h-3.5" /> Speed (Mean)
          </span>
          <span className="text-xl font-semibold text-neutral-800">
            {diagnostics.latencyStats?.mean ? `${diagnostics.latencyStats.mean}ms` : 'N/A'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-neutral-700 flex items-center gap-2">
            <Folder className="w-4 h-4 text-neutral-400" />
            Storage by Domain
          </h3>
          {Object.keys(diagnostics.storageByDomain).length === 0 ? (
            <div className="text-sm text-neutral-400 italic">No domain data.</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(diagnostics.storageByDomain)
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .map(([domain, count]) => (
                  <div key={domain} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-600 truncate mr-2">{domain}</span>
                    <span className="text-neutral-900 font-medium bg-neutral-100 px-2 py-0.5 rounded-full text-xs">
                      {count.toLocaleString()}
                    </span>
                  </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-neutral-700 flex items-center gap-2">
            <Shield className="w-4 h-4 text-neutral-400" />
            Storage by Agent Role
          </h3>
          {Object.keys(diagnostics.storageByRole).length === 0 ? (
            <div className="text-sm text-neutral-400 italic">No role data.</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(diagnostics.storageByRole)
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .map(([role, count]) => (
                  <div key={role} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-600 truncate mr-2">{role}</span>
                    <span className="text-neutral-900 font-medium bg-neutral-100 px-2 py-0.5 rounded-full text-xs">
                      {count.toLocaleString()}
                    </span>
                  </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-indigo-50/50 p-4 rounded-xl border border-indigo-100 mt-4 text-sm text-neutral-700">
        <h3 className="font-medium flex items-center gap-1.5 mb-2 text-indigo-900">
            <Activity className="w-4 h-4" /> Optimization Insights
        </h3>
        {diagnostics.modelSuggestions ? (
          <div className="text-neutral-700 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: diagnostics.modelSuggestions }} />
        ) : (
          <ul className="space-y-1.5 list-disc list-inside">
            <li><strong>Speed & Cost:</strong> Groq (Mixtral / Gemma) is recommended for high-speed routing and fast token processing on the free tier.</li>
            <li><strong>Deep Reasoning:</strong> Google Gemini Flash / DeepSeek R1 (via OpenRouter Free) are best suited for deep synthesis and manager verification steps without losing functionality.</li>
            <li><strong>Current Cache Hit Ratio:</strong> {diagnostics.cacheHitRatio !== undefined ? `${(diagnostics.cacheHitRatio * 100).toFixed(1)}%` : 'N/A'}. A higher ratio speeds up analysis and lowers cost.</li>
            <li><strong>Throughput:</strong> p95 latency is {diagnostics.latencyStats?.p95 ? `${diagnostics.latencyStats.p95}ms` : 'N/A'}, p99 is {diagnostics.latencyStats?.p99 ? `${diagnostics.latencyStats.p99}ms` : 'N/A'}.</li>
          </ul>
        )}
      </div>

    </div>
  );
}
