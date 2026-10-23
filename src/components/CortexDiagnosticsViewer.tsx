import React, { useEffect, useState } from 'react';
import { Database, Server, Folder, Shield, Activity, RefreshCw, Zap, Cpu, Settings, Coins, Key, Target, Award, Sliders } from 'lucide-react';
import { authHeaders } from '../services/appAuthHeaders';
import { parseHttpError } from '../services/httpError';

interface RoleRecommendation {
  role: string;
  recommendedProvider: string;
  recommendedModel: string;
  reason: string;
}

interface SeatAccuracyEntry {
  appId: string;
  role: string;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winRate: number;
  ucb1Score: number;
  capabilityScore: number;
}

interface LearningTelemetry {
  supabaseConfigured: boolean;
  calibrationAppId: string;
  calibration: {
    globalBias: number;
    sportBias: Record<string, number>;
    sampleSize: number;
    sportSamples: Record<string, number>;
    brier: number;
    meanPredicted: number;
    meanActual: number;
  };
  seatAccuracy: SeatAccuracyEntry[];
}

interface CortexDiagnostics {
  qdrantAvailable: boolean;
  collectionName: string;
  pointCount: number;
  appCount: number;
  apps: string[];
  fallbackStoreSize: number;
  storageByDomain: Record<string, number>;
  storageByRole: Record<string, number>;
  latencyStats?: {
      mean: number | null;
      p95: number | null;
      p99: number | null;
  };
  cacheHitRatio?: number;
  totalTokensBurned?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  errorRate?: number;
  totalRequests?: number;
  failureCount?: number;
  modelSuggestions?: string;
  roleRecommendations?: RoleRecommendation[];
  learningTelemetry?: LearningTelemetry;
}

export function CortexDiagnosticsViewer() {
  const [diagnostics, setDiagnostics] = useState<CortexDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string>('global');
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationStatus, setCalibrationStatus] = useState<string | null>(null);

  const handleCalibratePolicy = async () => {
    setCalibrating(true);
    setCalibrationStatus(null);
    try {
      const targetApp = selectedApp === 'global' ? undefined : selectedApp;
      const res = await fetch('/api/swarm/calibrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders()
        },
        body: JSON.stringify({
          appId: targetApp,
          iterations: 400,
          autoApply: true,
          minSamples: 2
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCalibrationStatus(payload?.message || payload?.error || 'Calibration requires more graded outcomes.');
      } else {
        setCalibrationStatus(`Calibrated policy weights (Brier / R² updated across ${payload?.sampleSize ?? 'active'} samples).`);
        await fetchDiagnostics();
      }
    } catch (err: any) {
      setCalibrationStatus(err?.message || 'Calibration request failed');
    } finally {
      setCalibrating(false);
    }
  };

  const fetchDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch cortex diagnostics
      const url = selectedApp === 'global' ? '/api/swarm/cortex/diagnostics' : `/api/swarm/cortex/diagnostics?appId=${encodeURIComponent(selectedApp)}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        const parsed = await parseHttpError(res);
        if (parsed.kind === 'app-auth') {
          setIsAuthError(true);
        }
        throw new Error(parsed.message);
      }
      setIsAuthError(false);
      const data = await res.json();

      // Fetch speed/latency & cost diagnostics via telemetry
      const metricsRes = await fetch('/api/swarm/metrics', { headers: authHeaders() });
      let telemetryData: any = {};
      if (metricsRes.ok) {
        telemetryData = await metricsRes.json().catch(() => ({}));
      }

      setDiagnostics({
        ...data,
        latencyStats: telemetryData.modelMs,
        cacheHitRatio: telemetryData.cacheHitRatio,
        totalTokensBurned: telemetryData.totalTokensBurned ?? 0,
        promptTokens: telemetryData.promptTokens ?? 0,
        completionTokens: telemetryData.completionTokens ?? 0,
        estimatedCostUsd: telemetryData.estimatedCostUsd ?? 0,
        errorRate: telemetryData.errorRate ?? 0,
        totalRequests: telemetryData.totalRequests ?? 0,
        failureCount: telemetryData.failureCount ?? 0
      });
    } catch (err: any) {
      setError(err.message || 'Error fetching diagnostics');
    } finally {
      setLoading(false);
    }
  };

  // Listen for app token updates to resume polling after 401
  useEffect(() => {
    const handleTokenChange = () => {
      setIsAuthError(false);
      fetchDiagnostics();
    };

    window.addEventListener('swarm_token_changed', handleTokenChange);
    window.addEventListener('storage', handleTokenChange);

    return () => {
      window.removeEventListener('swarm_token_changed', handleTokenChange);
      window.removeEventListener('storage', handleTokenChange);
    };
  }, [selectedApp]);

  useEffect(() => {
    fetchDiagnostics();

    let interval: any;

    const startPolling = () => {
      if (interval) clearInterval(interval);
      if (!isAuthError) {
        interval = setInterval(fetchDiagnostics, 30000); // refresh every 30s
      }
    };

    const stopPolling = () => {
      if (interval) clearInterval(interval);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else if (!isAuthError) {
        fetchDiagnostics();
        startPolling();
      }
    };

    if (!isAuthError) {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [selectedApp, isAuthError]);


  if (loading && !diagnostics) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 animate-pulse flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-neutral-500">Loading Cortex Diagnostics...</span>
      </div>
    );
  }

  if (error && !diagnostics) {
    if (isAuthError) {
      return (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 text-neutral-700 flex flex-col gap-2">
          <div className="font-semibold flex items-center gap-2 text-neutral-800">
            <Key className="w-5 h-5 text-indigo-600" /> App Token Required
          </div>
          <div className="text-sm text-neutral-500">
            Cortex diagnostics require dashboard authentication. Add an app token in Settings → API Keys to view real-time diagnostics and memory metrics.
          </div>
          <button
            onClick={() => {
              setIsAuthError(false);
              fetchDiagnostics();
            }}
            className="self-start mt-2 text-sm bg-neutral-100 hover:bg-neutral-200 text-neutral-700 px-3 py-1.5 rounded-lg transition"
          >
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-red-200 text-red-600 flex flex-col gap-2">
        <div className="font-semibold flex items-center gap-2">
          <Activity className="w-5 h-5" /> Cortex Diagnostics Error
        </div>
        <div className="text-sm">{error}</div>
        <button
          onClick={() => {
            setIsAuthError(false);
            fetchDiagnostics();
          }}
          className="self-start mt-2 text-sm bg-red-50 px-3 py-1.5 rounded hover:bg-red-100 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!diagnostics) return null;

  const cal = diagnostics.learningTelemetry?.calibration;
  const seatAccuracy = diagnostics.learningTelemetry?.seatAccuracy || [];
  const supabaseConfigured = diagnostics.learningTelemetry?.supabaseConfigured ?? false;

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-neutral-100 pb-4 gap-4">
        <h2 className="text-xl font-medium flex items-center gap-2">
          <Database className="w-5 h-5 text-indigo-600" />
          Real-time Health Report
        </h2>

        <div className="flex items-center gap-3">
          {diagnostics.apps && diagnostics.apps.length > 0 && (
            <select
              value={selectedApp}
              onChange={(e) => setSelectedApp(e.target.value)}
              className="text-sm bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-1.5 text-neutral-700 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              <option value="global">All Apps (Global)</option>
              {diagnostics.apps.map(app => (
                <option key={app} value={app}>{app}</option>
              ))}
            </select>
          )}
          <button
            onClick={fetchDiagnostics}
            disabled={loading}
            className="p-1.5 text-neutral-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
            title="Refresh Diagnostics"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
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
            {diagnostics.latencyStats?.mean !== null && diagnostics.latencyStats?.mean !== undefined ? `${diagnostics.latencyStats.mean}ms` : 'null'}
          </span>
        </div>
      </div>

      <div className="border border-neutral-200 rounded-xl p-4 bg-gradient-to-r from-neutral-50 to-indigo-50/30 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-800 flex items-center gap-1.5">
            <Coins className="w-4 h-4 text-indigo-600" /> Session Cost & Efficiency Dashboard
          </h3>
          <span className="text-[11px] font-medium px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full">
            100% Free-Tier Mode ($0.00 Incurred)
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white p-3 rounded-lg border border-neutral-100 shadow-xs text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Tokens Burned</span>
            <span className="text-lg font-bold text-neutral-800">
              {(diagnostics.totalTokensBurned || 0).toLocaleString()}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              {(diagnostics.promptTokens || 0).toLocaleString()} in · {(diagnostics.completionTokens || 0).toLocaleString()} out
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 shadow-xs text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Commercial Value</span>
            <span className="text-lg font-bold text-emerald-600">
              ${(diagnostics.estimatedCostUsd || 0).toFixed(4)}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              Saved via free tiers
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 shadow-xs text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Error Rate</span>
            <span className={`text-lg font-bold ${(diagnostics.errorRate || 0) > 0.1 ? 'text-red-600' : 'text-neutral-800'}`}>
              {((diagnostics.errorRate || 0) * 100).toFixed(1)}%
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              {diagnostics.failureCount || 0} failed / {diagnostics.totalRequests || 0} reqs
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 shadow-xs text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Cache Hit Rate</span>
            <span className="text-lg font-bold text-indigo-600">
              {diagnostics.cacheHitRatio !== undefined ? `${(diagnostics.cacheHitRatio * 100).toFixed(1)}%` : '0.0%'}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              Deduplicated requests
            </span>
          </div>
        </div>
      </div>

      {/* Closed-Loop Learning & Calibration Telemetry */}
      <div className="border border-neutral-200 rounded-xl p-4 bg-neutral-50/70 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-neutral-800 flex items-center gap-1.5">
              <Target className="w-4 h-4 text-indigo-600" /> Closed-Loop Learning & Calibration Telemetry
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Contrastive Qdrant episodic post-mortems, Supabase line-movement steam & team bias, and per-seat Brier calibration
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${supabaseConfigured ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-neutral-100 text-neutral-600 border-neutral-200'}`}>
              Supabase Sync: {supabaseConfigured ? 'Connected' : 'Local Mode'}
            </span>
            <button
              onClick={handleCalibratePolicy}
              disabled={calibrating}
              className="text-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition"
            >
              <Sliders className="w-3.5 h-3.5" />
              {calibrating ? 'Calibrating...' : 'Calibrate Policy Weights'}
            </button>
          </div>
        </div>

        {calibrationStatus && (
          <div className="text-xs bg-white border border-indigo-100 text-indigo-800 px-3 py-2 rounded-lg">
            {calibrationStatus}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white p-3 rounded-lg border border-neutral-100 text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Graded Samples</span>
            <span className="text-lg font-bold font-mono text-neutral-800">
              {cal ? cal.sampleSize : 0}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              {cal && cal.sampleSize >= 8 ? 'Active Logit Calibration' : 'Need 8+ for Bias Shift'}
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Empirical Brier Score</span>
            <span className="text-lg font-bold font-mono text-indigo-600">
              {cal && cal.sampleSize > 0 ? cal.brier.toFixed(3) : '0.250'}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              Lower is sharper (0.25 = coinflip)
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Global Logit Bias</span>
            <span className="text-lg font-bold font-mono text-neutral-800">
              {cal ? `${cal.globalBias >= 0 ? '+' : ''}${cal.globalBias.toFixed(3)}` : '+0.000'}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              Stated {cal ? `${(cal.meanPredicted * 100).toFixed(1)}%` : '50.0%'} vs Hit {cal ? `${(cal.meanActual * 100).toFixed(1)}%` : '50.0%'}
            </span>
          </div>

          <div className="bg-white p-3 rounded-lg border border-neutral-100 text-center">
            <span className="text-[11px] text-neutral-500 font-medium block">Tracked Specialist Seats</span>
            <span className="text-lg font-bold font-mono text-emerald-600">
              {seatAccuracy.length}
            </span>
            <span className="text-[10px] text-neutral-400 block mt-0.5">
              Per-seat UCB1 & Brier pooling
            </span>
          </div>
        </div>

        {seatAccuracy.length > 0 && (
          <div className="bg-white rounded-lg border border-neutral-200 overflow-hidden">
            <div className="px-3 py-2 bg-neutral-50 border-b border-neutral-200 text-xs font-semibold text-neutral-700 flex items-center gap-1.5">
              <Award className="w-3.5 h-3.5 text-indigo-600" /> Per-Seat Specialist Accuracy & UCB1 Weighting
            </div>
            <div className="divide-y divide-neutral-100">
              {seatAccuracy.slice(0, 6).map((seat) => (
                <div key={`${seat.appId}:${seat.role}`} className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-neutral-800">{seat.role}</span>
                    <span className="text-[10px] text-neutral-400 font-mono">({seat.appId})</span>
                  </div>
                  <div className="flex items-center gap-4 font-mono">
                    <span className="text-neutral-600">
                      {seat.wins}W-{seat.losses}L{seat.pushes > 0 ? `-${seat.pushes}P` : ''}
                    </span>
                    <span className={`font-semibold ${seat.winRate >= 0.55 ? 'text-emerald-600' : seat.winRate < 0.45 ? 'text-amber-600' : 'text-neutral-700'}`}>
                      {(seat.winRate * 100).toFixed(1)}% Win
                    </span>
                    <span className="text-indigo-600">
                      UCB1 {seat.ucb1Score.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
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

      {diagnostics.roleRecommendations && diagnostics.roleRecommendations.length > 0 ? (
        <div className="bg-indigo-50/50 p-5 rounded-xl border border-indigo-100 mt-4">
          <h3 className="font-medium flex items-center gap-2 mb-4 text-indigo-900">
            <Cpu className="w-5 h-5" /> Tailored Model Recommendations
          </h3>
          <div className="space-y-4">
            {diagnostics.roleRecommendations.map((rec, idx) => (
              <div key={idx} className="bg-white p-4 rounded-lg shadow-sm border border-indigo-50/50 flex flex-col md:flex-row md:items-start gap-4">
                <div className="bg-indigo-100 text-indigo-800 text-xs font-semibold px-2.5 py-1 rounded-md uppercase tracking-wide md:w-32 flex-shrink-0 text-center">
                  {rec.role}
                </div>
                <div className="flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                    <Settings className="w-4 h-4 text-neutral-400" />
                    <span>{rec.recommendedProvider} / {rec.recommendedModel}</span>
                  </div>
                  <p className="text-sm text-neutral-600">{rec.reason}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 text-xs text-indigo-700/80 flex justify-between items-center px-1">
             <span>Cache Hit Ratio: {diagnostics.cacheHitRatio !== undefined ? `${(diagnostics.cacheHitRatio * 100).toFixed(1)}%` : 'N/A'}</span>
             <span>P95 Latency: {diagnostics.latencyStats?.p95 !== null && diagnostics.latencyStats?.p95 !== undefined ? `${diagnostics.latencyStats.p95}ms` : 'null'}</span>
          </div>
        </div>
      ) : (
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
              <li><strong>Throughput:</strong> p95 latency is {diagnostics.latencyStats?.p95 !== null && diagnostics.latencyStats?.p95 !== undefined ? `${diagnostics.latencyStats.p95}ms` : 'null'}, p99 is {diagnostics.latencyStats?.p99 !== null && diagnostics.latencyStats?.p99 !== undefined ? `${diagnostics.latencyStats.p99}ms` : 'null'}.</li>
            </ul>
          )}
        </div>
      )}

    </div>
  );
}

