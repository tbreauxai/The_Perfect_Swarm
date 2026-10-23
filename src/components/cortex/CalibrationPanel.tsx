import React from 'react';
import { Target, Sliders } from 'lucide-react';
import type { LearningTelemetry } from './types';
import { SeatAccuracyTable } from './SeatAccuracyTable';

export interface CalibrationPanelProps {
  telemetry?: LearningTelemetry;
  calibrating: boolean;
  calibrationStatus: string | null;
  onCalibrate: () => void;
}

export const CalibrationPanel: React.FC<CalibrationPanelProps> = ({
  telemetry,
  calibrating,
  calibrationStatus,
  onCalibrate
}) => {
  const cal = telemetry?.calibration;
  const seatAccuracy = telemetry?.seatAccuracy || [];
  const supabaseConfigured = telemetry?.supabaseConfigured ?? false;

  return (
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
            onClick={onCalibrate}
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

      <SeatAccuracyTable seatAccuracy={seatAccuracy} />
    </div>
  );
};
