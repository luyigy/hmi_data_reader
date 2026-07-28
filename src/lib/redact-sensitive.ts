const REDACTED = '[REDACTED]';

const sensitiveName = '(?:[A-Za-z_][A-Za-z0-9_]*?(?:TOKEN|PASSWORD|PASS|SECRET|API_KEY|PRIVATE_KEY)|token|password|passwd|pwd|secret)';
const sensitiveValue = '(?:"[^"]*"|\'[^\']*\'|[^\\s,;}&]+)';

/** Redacts credentials before untrusted process output reaches durable or visible channels. */
export const redactSensitiveText = (value: string) => value
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
  .replace(new RegExp(`([?&]${sensitiveName}=)[^&#\\s]+`, 'gi'), `$1${REDACTED}`)
  .replace(new RegExp(`(\\b${sensitiveName}\\b\\s*(?:=|:)\\s*)${sensitiveValue}`, 'gi'), `$1${REDACTED}`)
  .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`);

export const redactSensitiveValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSensitiveValue(nested)]));
  }
  return value;
};
