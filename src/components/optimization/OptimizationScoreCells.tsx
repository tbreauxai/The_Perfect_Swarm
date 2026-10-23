import React from 'react';
import type { OptimizationResult } from './types';

export interface OptimizationScoreCellsProps {
    scores: OptimizationResult['scores'];
}

export const OptimizationScoreCells: React.FC<OptimizationScoreCellsProps> = ({ scores }) => {
    return (
        <>
            <td className="px-4 py-3 font-semibold text-purple-700">{scores.speed || '-'}</td>
            <td className="px-4 py-3 font-semibold text-blue-700">{scores.intelligence || '-'}</td>
            <td className="px-4 py-3 font-semibold text-emerald-700">{scores.accuracy || '-'}</td>
        </>
    );
};
