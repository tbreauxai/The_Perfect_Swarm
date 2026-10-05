const APP_TOKEN_KEY = 'swarm_app_token';

export function getAppToken(): string {
    try {
        return localStorage.getItem(APP_TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

export function setAppToken(token: string) {
    try {
        if (token) localStorage.setItem(APP_TOKEN_KEY, token);
        else localStorage.removeItem(APP_TOKEN_KEY);
    } catch {
        /* private mode */
    }
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers = { ...extra };
    const token = getAppToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}
