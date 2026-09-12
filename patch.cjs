const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(
  "const [finalAnalysis, setFinalAnalysis] = useState('');",
  "const [finalAnalysis, setFinalAnalysis] = useState<any>(null);"
);

code = code.replace(
  "import { Brain, Settings, FileJson, Play, X, Bot, Database, Activity, BarChart, ChevronDown, ChevronUp } from 'lucide-react';",
  "import { Brain, Settings, FileJson, Play, X, Bot, Database, Activity, BarChart, ChevronDown, ChevronUp } from 'lucide-react';\nimport { ComponentRegistry } from './components/generative/ComponentRegistry';"
);

const oldRender = `{finalAnalysis && (
                    <div className="mt-8 pt-6 border-t border-neutral-200">
                        <h3 className="text-lg font-semibold text-neutral-800 mb-4 flex items-center gap-2">
                            <BarChart className="w-5 h-5 text-indigo-600" />
                            Final Result
                        </h3>
                        <div className="bg-indigo-50 p-5 rounded-xl border border-indigo-100 text-neutral-800 text-sm whitespace-pre-wrap leading-relaxed">
                            {finalAnalysis}
                        </div>
                    </div>
                )}`;

const newRender = `{finalAnalysis && (
                    <div className="mt-8 pt-6 border-t border-neutral-200">
                        <h3 className="text-lg font-semibold text-neutral-800 mb-4 flex items-center gap-2">
                            <BarChart className="w-5 h-5 text-indigo-600" />
                            {finalAnalysis.ui_title || "Generated Dashboard"}
                        </h3>
                        
                        {finalAnalysis.error ? (
                          <div className="bg-red-50 p-5 rounded-xl border border-red-100 text-red-800 text-sm whitespace-pre-wrap leading-relaxed">
                              {finalAnalysis.error}
                          </div>
                        ) : finalAnalysis.components ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {finalAnalysis.components.map((comp: any) => (
                              <div key={comp.id || Math.random()} className={comp.type === 'DataTable' ? 'md:col-span-2' : ''}>
                                <ComponentRegistry component={comp} />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-indigo-50 p-5 rounded-xl border border-indigo-100 text-neutral-800 text-sm whitespace-pre-wrap leading-relaxed">
                              {JSON.stringify(finalAnalysis, null, 2)}
                          </div>
                        )}
                    </div>
                )}`;

code = code.replace(oldRender, newRender);

fs.writeFileSync('src/App.tsx', code);
