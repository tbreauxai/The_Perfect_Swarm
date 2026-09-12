import React from 'react';
import { MetricCard } from './MetricCard';
import { InsightList } from './InsightList';
import { DataTable } from './DataTable';

export type ComponentType = 'MetricCard' | 'InsightList' | 'DataTable';

export interface GenerativeComponent {
  id: string;
  type: ComponentType;
  props: any;
}

export function ComponentRegistry({ component }: { component: GenerativeComponent }) {
  switch (component.type) {
    case 'MetricCard':
      return <MetricCard {...component.props} />;
    case 'InsightList':
      return <InsightList {...component.props} />;
    case 'DataTable':
      return <DataTable {...component.props} />;
    default:
      return (
        <div className="p-4 border border-red-200 bg-red-50 text-red-600 rounded-lg text-sm">
          Unknown component type: {component.type}
        </div>
      );
  }
}
