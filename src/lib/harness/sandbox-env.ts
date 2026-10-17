const system = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'COLORTERM', 'TZ',
  'AP_PROJECT_REPOSITORY', 'TASK_GRAPH_UPSTREAM_INPUTS_JSON', 'TASK_GRAPH_REPOSITORIES_JSON', 'TASK_GRAPH_OUTPUT_DIR', 'NPM_CONFIG_CACHE', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'AP_TASK_SANDBOX', 'AP_SANDBOX_MODEL_ACCESS',
  'CODEX_HOME', 'KIMI_CODE_HOME', 'KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'KIMI_API_KEY', 'KIMI_BASE_URL', 'MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL']);

/** Remove platform credentials by name, never put secret values in the launch arguments. */
export function sandboxEnvironmentRemovals(env: NodeJS.ProcessEnv) {
  if (env.AP_TASK_SANDBOX !== '1') return [];
  return Object.keys(env).filter((key) => {
    if (env.AP_SANDBOX_MODEL_ACCESS !== '1' && ['OPENAI_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY'].includes(key)) return true;
    return !system.has(key) && !/^LC_[A-Z_]+$/.test(key);
  });
}
