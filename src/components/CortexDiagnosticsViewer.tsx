import React, { useEffect, useState } from 'react';
import { Database, Folder, Shield, Activity, RefreshCw, Key } from 'lucide-react';
import { authHeaders } from '../services/appAuthHeaders';
import { parseHttpError } from '../services/httpError';
import type { CortexDiagnostics } from './cortex/types';
import { CortexOverviewCards } from './cortex/CortexOverviewCards';
import { CalibrationPanel } from './cortex/CalibrationPanel';
import { RoleRecommendationsList } from './cortex/RoleRecommendationsList';

export type { CortexDiagnostics, RoleRecommendation, SeatAccuracyEntry, LearningTelemetry } from './cortex/types';

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
      setCalibrationStatus(err.message || 'Failed to trigger policy calibration.');
    } finally {
      setCalibrating(false);
    }
  };

  const fetchDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = selectedApp === 'global'
        ? '/api/swarm/cortex/diagnostics'
        : `/api/swarm/cortex/diagnostics?appId=${encodeURIComponent(selectedApp)}`;

      const res = await fetch(url, {
        headers: authHeaders()
      });

      if (!res.ok) {
        if (res.status === 401) {
          setIsAuthError(true);
          setError('App token required to view diagnostics.');
          return;
        }
        setIsAuthError(false);
        const parsed = await parseHttpError(res);
        throw new Error(parsed.message);
      }

      setIsAuthError(false);
      const data = await res.json();
      setDiagnostics(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load Cortex diagnostics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiagnostics();
    const interval = setInterval(fetchDiagnostics, 10000);
    return () => clearInterval(interval);
  }, [selectedApp]);

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

      <CortexOverviewCards diagnostics={diagnostics} />

      <CalibrationPanel
        telemetry={diagnostics.learningTelemetry}
        calibrating={calibrating}
        calibrationStatus={calibrationStatus}
        onCalibrate={handleCalibratePolicy}
      />

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

      <RoleRecommendationsList diagnostics={diagnostics} />
    </div>
  );
}
