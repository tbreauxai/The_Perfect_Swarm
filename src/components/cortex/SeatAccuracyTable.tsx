import React from 'react';
import { Award } from 'lucide-react';
import type { SeatAccuracyEntry } from './types';

export interface SeatAccuracyTableProps {
  seatAccuracy: SeatAccuracyEntry[];
}

export const SeatAccuracyTable: React.FC<SeatAccuracyTableProps> = ({ seatAccuracy }) => {
  if (seatAccuracy.length === 0) return null;

  return (
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
  );
};
