import React from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
}

export function MetricCard({ title, value, subtitle, trend }: MetricCardProps) {
  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-neutral-200 flex flex-col">
      <h3 className="text-sm font-medium text-neutral-500 mb-1">{title}</h3>
      <div className="flex items-baseline space-x-2">
        <span className="text-2xl font-bold text-neutral-900">{value}</span>
        {trend && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            trend === 'up' ? 'bg-green-100 text-green-700' :
            trend === 'down' ? 'bg-red-100 text-red-700' :
            'bg-neutral-100 text-neutral-700'
          }`}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
          </span>
        )}
      </div>
      {subtitle && <p className="text-xs text-neutral-400 mt-2">{subtitle}</p>}
    </div>
  );
}
