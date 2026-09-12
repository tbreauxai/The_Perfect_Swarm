import React from 'react';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';

interface Insight {
  type: 'success' | 'warning' | 'info';
  message: string;
}

interface InsightListProps {
  title: string;
  insights: Insight[];
}

export function InsightList({ title, insights }: InsightListProps) {
  return (
    <div className="bg-white p-5 rounded-xl shadow-sm border border-neutral-200">
      <h3 className="text-md font-semibold text-neutral-800 mb-4">{title}</h3>
      <ul className="space-y-3">
        {insights.map((insight, idx) => (
          <li key={idx} className="flex items-start space-x-3">
            <span className="mt-0.5">
              {insight.type === 'success' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
              {insight.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-500" />}
              {insight.type === 'info' && <Info className="w-5 h-5 text-blue-500" />}
            </span>
            <span className="text-sm text-neutral-600 leading-relaxed">
              {insight.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
