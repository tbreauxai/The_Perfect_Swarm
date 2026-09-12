const fs = require('fs');

// Patch server.ts
let serverCode = fs.readFileSync('server.ts', 'utf-8');
serverCode = serverCode.replace(
    /if \(settings\?\.githubToken \|\| process\.env\.GITHUB_TOKEN\) \{\s*analysts\.push\(new Agent\('GitHub Analyst', 'gpt-4o', 'github', settings\?\.githubToken \|\| process\.env\.GITHUB_TOKEN\)\);\s*\}/,
    '// GitHub Models API is retired and has been removed from the swarm.'
);
fs.writeFileSync('server.ts', serverCode);

// Patch App.tsx
let appCode = fs.readFileSync('src/App.tsx', 'utf-8');
const githubUIBlock = `                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-neutral-700">GitHub Models (gpt-4o)</label>
                    <span className="px-2 py-0.5 bg-neutral-100 text-neutral-600 rounded text-xs font-medium border border-neutral-200">Heavy Analyst</span>
                  </div>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <div className="w-1.5 h-1.5 rounded-full bg-neutral-400"></div>
                    </div>
                    <div className="pl-6">
                      <input 
                        type="password" 
                        value={settings.githubToken || ''}
                        onChange={(e) => updateSetting('githubToken', e.target.value)}
                        placeholder="github_pat_..."
                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm font-mono"
                      />
                      <p className="text-[10px] text-neutral-400 mt-1">Required to use GitHub's Model API.</p>
                    </div>
                  </div>`;
                  
const retiredUIBlock = `                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-neutral-700">GitHub Models (gpt-4o)</label>
                    <span className="px-2 py-0.5 bg-rose-100 text-rose-700 rounded text-xs font-medium border border-rose-200">RETIRED</span>
                  </div>
                  <div className="relative">
                    <div className="pl-6">
                      <p className="text-xs text-neutral-500 mt-1">The GitHub Models API was officially retired on July 30, 2026 and is no longer available.</p>
                    </div>
                  </div>`;
                  
appCode = appCode.replace(githubUIBlock, retiredUIBlock);
fs.writeFileSync('src/App.tsx', appCode);
