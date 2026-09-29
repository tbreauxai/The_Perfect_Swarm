import React, { useState, useEffect, useMemo } from 'react';

interface Column {
  key: string;
  header: string;
}

interface DataTableProps {
  title: string;
  columns: Column[];
  rows: Record<string, any>[];
  pageSize?: number;
}

export function DataTable({ title, columns, rows, pageSize = 50 }: DataTableProps) {
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const visibleRows = useMemo(() => {
    return rows.slice(startIndex, startIndex + pageSize);
  }, [rows, startIndex, pageSize]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-neutral-100 bg-neutral-50/50 flex items-center justify-between">
        <h3 className="text-md font-semibold text-neutral-800">{title}</h3>
        {rows.length > pageSize && (
          <span className="text-xs text-neutral-500 font-mono">
            {rows.length.toLocaleString()} total rows
          </span>
        )}
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
            {visibleRows.map((row, rowIdx) => (
              <tr key={startIndex + rowIdx} className="hover:bg-neutral-50/50 transition-colors">
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
      {rows.length > pageSize && (
        <div className="px-5 py-3 border-t border-neutral-100 bg-neutral-50/50 flex items-center justify-between text-xs text-neutral-600">
          <span>
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, rows.length)} of {rows.length.toLocaleString()} rows
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-2.5 py-1 rounded border border-neutral-200 bg-white hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              Previous
            </button>
            <span className="font-mono px-1">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-2.5 py-1 rounded border border-neutral-200 bg-white hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
