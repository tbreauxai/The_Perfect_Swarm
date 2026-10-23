import React from 'react';
import { Cpu, Settings, Activity } from 'lucide-react';
import type { CortexDiagnostics } from './types';

export interface RoleRecommendationsListProps {
  diagnostics: CortexDiagnostics;
}

export const RoleRecommendationsList: React.FC<RoleRecommendationsListProps> = ({ diagnostics }) => {
  if (diagnostics.roleRecommendations && diagnostics.roleRecommendations.length > 0) {
    return (
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
    );
  }

  return (
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
  );
};
