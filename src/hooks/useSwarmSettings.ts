import { useState, useEffect } from 'react';
import type { AppSettings } from '../components/SettingsModal';
import { authHeaders } from '../services/appAuthHeaders';

export function useSwarmSettings() {
  const [showSettings, setShowSettings] = useState(false);
  const [envStatus, setEnvStatus] = useState<any>({});

  useEffect(() => {
    fetch('/api/config/status', { headers: authHeaders() })
      .then(res => res.text())
      .then(text => {
        try {
          setEnvStatus(JSON.parse(text));
        } catch (e) {
          console.error('Config status parse error:', text);
        }
      })
      .catch(console.error);
  }, []);

  const [settings, setSettings] = useState<AppSettings>({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    mistralApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: '',
    githubToken: '',
    appId: 'perfect-swarm',
    disableFallback: false,
    forceFullSwarm: false,
    agents: [
      { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-3.5-flash' },
      { id: 'a1', role: 'Analyst 1', provider: 'gemini', model: 'gemini-3.5-flash' },
      { id: 'a2', role: 'Analyst 2', provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { id: 'a3', role: 'Analyst 3', provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      { id: 'a4', role: 'Analyst 4', provider: 'mistral', model: 'mistral-small-latest' },
      { id: 'critic', role: 'Verification Critic', provider: 'gemini', model: 'gemini-3.5-flash-lite' }
    ]
  });

  useEffect(() => {
    const saved = localStorage.getItem('swarm_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        let modified = false;

        if (parsed.disableFallback === true && !localStorage.getItem('swarm_disable_fallback_explicit')) {
          parsed.disableFallback = false;
          modified = true;
        }

        if (parsed.agents && Array.isArray(parsed.agents)) {
          parsed.agents = parsed.agents.map((a: any) => {
            if (a.provider === 'gemini' && a.model === 'gemini-2.5-flash') {
              modified = true;
              return { ...a, model: 'gemini-3.5-flash' };
            }
            return a;
          });
        }

        // Auto-populate Verification Critic agent if missing from legacy settings
        if (Array.isArray(parsed.agents) && !parsed.agents.some((a: any) => a.id === 'critic' || a.role === 'Verification Critic')) {
          parsed.agents.push({ id: 'critic', role: 'Verification Critic', provider: 'gemini', model: 'gemini-3.5-flash-lite' });
          modified = true;
        }

        setSettings(prev => ({ ...prev, ...parsed }));

        if (modified) {
          localStorage.setItem('swarm_settings', JSON.stringify(parsed));
        }
      } catch (e) {
        console.error('Settings parse error:', e);
      }
    }
  }, []);

  const sanitizeSettingsForStorage = (stg: AppSettings): Partial<AppSettings> => {
    if (!stg.ephemeralKeys) return stg;
    return {
      ...stg,
      geminiApiKey: '',
      openRouterApiKey: '',
      groqApiKey: '',
      mistralApiKey: '',
      qdrantApiKey: '',
      githubToken: '',
      agents: stg.agents.map(a => ({ ...a, apiKey: '' }))
    };
  };

  const updateSetting = (key: keyof AppSettings, value: any) => {
    if (key === 'disableFallback') {
      localStorage.setItem('swarm_disable_fallback_explicit', 'true');
    }
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    localStorage.setItem('swarm_settings', JSON.stringify(sanitizeSettingsForStorage(newSettings)));
  };

  const updateAgent = (id: string, field: string, value: string) => {
    setSettings(prev => {
      const newSettings = {
        ...prev,
        agents: prev.agents.map(a => a.id === id ? { ...a, [field]: value } : a)
      };
      localStorage.setItem('swarm_settings', JSON.stringify(sanitizeSettingsForStorage(newSettings)));
      return newSettings;
    });
  };

  const applyModelToSettings = (role: string, provider: string, model: string) => {
    setSettings(prev => {
      const updated = {
        ...prev,
        agents: prev.agents.map(a =>
          a.role === role ? { ...a, provider, model } : a
        )
      };
      localStorage.setItem('swarm_settings', JSON.stringify(sanitizeSettingsForStorage(updated)));
      return updated;
    });
  };

  return {
    settings,
    setSettings,
    updateSetting,
    updateAgent,
    applyModelToSettings,
    showSettings,
    setShowSettings,
    envStatus
  };
}
