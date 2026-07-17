# Security Policy

## Supported Versions

This project is in active development. Security fixes are expected to land on the main development branch unless a release branch policy is introduced later.

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities involving credentials, remote execution, Feishu/Lark app access, gateway tokens, SSH access, or agent sandbox escapes.

Report privately to the project maintainers. Include:

- affected commit or version
- reproduction steps
- expected impact
- relevant logs with secrets removed

## Sensitive Data

Never commit:

- `.env` or `.env.*` files
- Feishu/Lark app secrets, verification tokens, or encrypt keys
- gateway tokens
- SSH private keys
- OpenAI, Anthropic, or other model-provider API keys
- local databases such as `prisma/dev.db`
- test artifacts that may contain screenshots, recordings, logs, or transcripts

If a secret was committed, rotate it immediately and clean git history before publishing the repository.
