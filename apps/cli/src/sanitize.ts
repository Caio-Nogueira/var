const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENCODE_CONFIG_RE = /OPENCODE_CONFIG_CONTENT\s*[=:]\s*\S+/g;
const PROVIDER_KEY_RE =
	/\b(?:ANTHROPIC|OPENAI|GOOGLE|GEMINI|GROQ|MISTRAL|AWS|AZURE|COHERE|TOGETHER)[A-Z0-9_]*(?:API_?)?KEY\s*=\s*[^\s]+/gi;
const AUTH_PATH_RE = /[^\s"']*\.config\/opencode\/[^\s"']*/g;

export function sanitizeText(value: unknown, maxLength = 4000): string {
	const text = String(value)
		.replace(OPENCODE_CONFIG_RE, "OPENCODE_CONFIG_CONTENT=[REDACTED]")
		.replace(BEARER_RE, "Bearer [REDACTED]")
		.replace(JWT_RE, "[REDACTED_JWT]")
		.replace(PROVIDER_KEY_RE, (match) => `${match.split("=")[0]}=[REDACTED]`)
		.replace(AUTH_PATH_RE, "[REDACTED_OPENCODE_AUTH_PATH]");

	if (text.length <= maxLength) return text;
	const suffix = "... [truncated]";
	if (maxLength <= suffix.length) return suffix.slice(0, maxLength);
	return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}
