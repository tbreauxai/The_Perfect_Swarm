# Product Guidelines: The Perfect Swarm

## Voice and Tone
- **Professional & Technical**: The primary audience is developers and data analysts. Use clear, precise, and objective language without being overly academic.
- **Informative & Transparent**: Errors from LLMs or API providers should be surfaced cleanly with actionable guidance (e.g., "Missing API Key for Manager Node provider. Please configure it in settings.").

## UI / UX Principles
- **Clean Layout**: Utilize ample whitespace with a neutral background (`bg-neutral-50`) to focus attention on the data and the execution trace.
- **Feedback & State**: Always provide immediate visual feedback for system states (e.g., spinning loaders during execution, distinct colors for Success/Failure, and interactive expandable logs).
- **Responsive & Scannable**: Data output and swarm execution events should be highly structured and scannable, employing semantic icons (like `lucide-react`) to quickly convey the state (e.g., AlertCircle for errors, Activity for traces).
- **Graceful Degradation**: If an LLM provider timeouts or fails, the rest of the swarm should continue execution or degrade gracefully, presenting the partial trace and errors clearly.

## Model Configuration & Preservation Guidelines
- **Zero Model Blacklists**: Never maintain or reintroduce a ban list or rejection list for AI models. Any model string configured by the user is strictly valid.
- **Respect User Selection**: Never override user-configured model names with assumed or "recommended" defaults. Always execute with the exact model string provided by the user in the settings box.
