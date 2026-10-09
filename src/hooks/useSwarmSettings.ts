import { useState, useEffect } from 'react';
import type { AppSettings } from '../components/SettingsModal';
import { authHeaders } from '../services/appAuthHeaders';

export const DEFAULT_SWARM_SETTINGS: AppSettings = {
  geminiApiKey: '',
  openRouterApiKey: '',
  groqApiKey: '',
  mistralApiKey: '',
  qdrantUrl: '',
  qdrantApiKey: '',
  githubToken: '',
  ephemeralKeys: true,
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
};

export function sanitizeSettingsForStorage(stg: Partial<AppSettings>): Partial<AppSettings> {
  const cleaned: Partial<AppSettings> = {
    ...stg,
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    mistralApiKey: '',
    qdrantApiKey: '',
    qdrantUrl: '',
    githubToken: '',
    ephemeralKeys: true,
    agents: (stg.agents || []).map(a => {
      const copy = { ...a };
      delete (copy as any).apiKey;
      delete (copy as any).geminiApiKey;
      delete (copy as any).openRouterApiKey;
      delete (copy as any).groqApiKey;
      delete (copy as any).mistralApiKey;
      delete (copy as any).githubToken;
      return copy;
    })
  };
  delete (cleaned as any).appToken;
  delete (cleaned as any).app_token;
  return cleaned;
}

export function cleanSavedSettings(saved: string | null): { cleanedSettings: Partial<AppSettings>; legacyAppToken?: string } | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    let legacyAppToken: string | undefined;

    if (parsed.appToken || parsed.app_token) {
      legacyAppToken = parsed.appToken || parsed.app_token;
      delete parsed.appToken;
      delete parsed.app_token;
    }

    parsed.geminiApiKey = '';
    parsed.openRouterApiKey = '';
    parsed.groqApiKey = '';
    parsed.mistralApiKey = '';
    parsed.githubToken = '';
    parsed.qdrantUrl = '';
    parsed.qdrantApiKey = '';
    parsed.ephemeralKeys = true;

    if (parsed.disableFallback === true && (typeof localStorage === 'undefined' || !localStorage.getItem('swarm_disable_fallback_explicit'))) {
      parsed.disableFallback = false;
    }

    if (parsed.agents && Array.isArray(parsed.agents)) {
      parsed.agents = parsed.agents.map((a: any) => {
        const cleanAgent = { ...a };
        delete cleanAgent.apiKey;
        delete cleanAgent.geminiApiKey;
        delete cleanAgent.openRouterApiKey;
        delete cleanAgent.groqApiKey;
        delete cleanAgent.mistralApiKey;
        delete cleanAgent.githubToken;
        if (cleanAgent.provider === 'gemini' && cleanAgent.model === 'gemini-2.5-flash') {
          cleanAgent.model = 'gemini-3.5-flash';
        }
        return cleanAgent;
      });
    }

    if (Array.isArray(parsed.agents) && !parsed.agents.some((a: any) => a.id === 'critic' || a.role === 'Verification Critic')) {
      parsed.agents.push({ id: 'critic', role: 'Verification Critic', provider: 'gemini', model: 'gemini-3.5-flash-lite' });
    }

    const cleaned = sanitizeSettingsForStorage(parsed as AppSettings);
    return { cleanedSettings: cleaned, legacyAppToken };
  } catch (e) {
    console.error('Settings parse error:', e);
    return null;
  }
}

export function useSwarmSettings() {
  const [showSettings, setShowSettings] = useState(false);
  const [envStatus, setEnvStatus] = useState<any>({});

  useEffect(() => {
    fetch('/api/config/status', { headers: authHeaders() })
      .then(async res => {
        if (!res.ok) {
          setEnvStatus({ authRequired: true });
          return;
        }
        const data = await res.json().catch(() => null);
        if (data) {
          setEnvStatus(data);
        } else {
          setEnvStatus({ authRequired: true });
        }
      })
      .catch(() => {
        setEnvStatus({ authRequired: true });
      });
  }, []);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SWARM_SETTINGS);

  useEffect(() => {
    const saved = localStorage.getItem('swarm_settings');
    const result = cleanSavedSettings(saved);
    if (result) {
      if (result.legacyAppToken && !localStorage.getItem('swarm_app_token')) {
        try {
          localStorage.setItem('swarm_app_token', result.legacyAppToken);
        } catch {}
      }
      setSettings(prev => ({ ...prev, ...(result.cleanedSettings as AppSettings) }));
      localStorage.setItem('swarm_settings', JSON.stringify(result.cleanedSettings));
    }
  }, []);

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
