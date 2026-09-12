const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

// Replace settings fields
code = code.replace(/vertexProjectId: '',\s*vertexLocation: '',\s*vertexAccessToken: ''/, "githubToken: ''");

// Replace the UI block for Vertex with GitHub Token
const vertexRegex = /<div className="pt-4 border-t border-neutral-200 mt-2">\s*<h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">Google Cloud Vertex AI<\/h4>[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>\s*<div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden">)/;

const githubUI = `<div className="pt-4 border-t border-neutral-200 mt-2">
                  <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">GitHub Models</h4>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">GitHub Personal Access Token</label>
                      <input 
                        type="password" 
                        value={settings.githubToken}
                        onChange={(e) => updateSetting('githubToken', e.target.value)}
                        placeholder="github_pat_..."
                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm font-mono"
                      />
                      <p className="text-[10px] text-neutral-400 mt-1">Required to use GitHub's Model API.</p>
                    </div>
                  </div>
                </div>`;

code = code.replace(vertexRegex, githubUI);

fs.writeFileSync('src/App.tsx', code);
