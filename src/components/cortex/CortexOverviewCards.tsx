import React from 'react';
import { Server, Zap, Coins } from 'lucide-react';
import type { CortexDiagnostics } from './types';

export interface CortexOverviewCardsProps {
  diagnostics: CortexDiagnostics;
}

export const CortexOverviewCards: React.FC<CortexOverviewCardsProps> = ({ diagnostics }) => {
  return (
    <>
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
    </>
  );
};
