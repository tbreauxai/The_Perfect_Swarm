import React from 'react';

interface Column {
  key: string;
  header: string;
}

interface DataTableProps {
  title: string;
  columns: Column[];
  rows: Record<string, any>[];
}

export function DataTable({ title, columns, rows }: DataTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-neutral-100 bg-neutral-50/50">
        <h3 className="text-md font-semibold text-neutral-800">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-neutral-600">
          <thead className="bg-neutral-50 border-b border-neutral-100 text-xs uppercase text-neutral-500">
            <tr>
              {columns.map(col => (
                <th key={col.key} className="px-5 py-3 font-medium">
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-neutral-50/50 transition-colors">
                {columns.map(col => (
                  <td key={col.key} className="px-5 py-3 whitespace-nowrap">
                    {row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
