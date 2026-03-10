# Real Agents Setup Guide

This guide explains how to register and use real coding agents (Codex, Claude Code) with the Agent Platform.

---

## 📋 Prerequisites

### 1. Codex (OpenAI)

**Installation**:
```bash
# Install via npm
npm install -g codex

# Or use the OpenAI CLI
npm install -g openai
```

**Configuration**:
```bash
# Set your API key
export OPENAI_API_KEY="your-api-key-here"

# Or add to .env file
echo "OPENAI_API_KEY=your-api-key-here" >> .env
```

**Test**:
```bash
codex --version
```

---

### 2. Claude Code (Anthropic)

**Installation**:
```bash
# Install via npm
npm install -g @anthropic-ai/claude-code
```

**Configuration**:
```bash
# Login to Claude
claude login

# Or set API key
export ANTHROPIC_API_KEY="your-api-key-here"

# Or add to .env file
echo "ANTHROPIC_API_KEY=your-api-key-here" >> .env
```

**Test**:
```bash
claude --version
```

---

## 🚀 Register Real Agents

### Method 1: Via API

**Check available agents**:
```bash
curl http://localhost:3000/api/agents/register-real
```

**Register Codex**:
```bash
curl -X POST http://localhost:3000/api/agents/register-real \
  -H "Content-Type: application/json" \
  -d '{"type": "codex", "name": "My Codex Agent"}'
```

**Register Claude Code**:
```bash
curl -X POST http://localhost:3000/api/agents/register-real \
  -H "Content-Type: application/json" \
  -d '{"type": "claude", "name": "My Claude Agent"}'
```

---

### Method 2: Via Dashboard (Coming Soon)

1. Go to http://localhost:3000
2. Click "Register Real Agent"
3. Select agent type (Codex or Claude Code)
4. Enter agent name
5. Click "Register"

---

## 🧪 Test Real Agents

### 1. Create a Task

Go to http://localhost:3000/tasks and create a new task:
- **Name**: "Test Codex"
- **Description**: "Test real agent execution"
- **Assign to**: Select your registered Codex or Claude agent

### 2. Execute the Task

Click the "🚀 执行任务" button on the task card.

### 3. View Results

The task will be executed by the real agent. Results will show:
- ✅ Success/Failure status
- 📝 Agent output
- 📁 Modified files (for Claude Code)
- ⏱️ Execution time

---

## 🔧 Troubleshooting

### Codex not found

**Problem**: `codex: command not found`

**Solution**:
```bash
# Install codex
npm install -g codex

# Or check if it's in a different location
which codex
```

### Claude Code not found

**Problem**: `claude: command not found`

**Solution**:
```bash
# Install claude code
npm install -g @anthropic-ai/claude-code

# Login
claude login

# Check installation
which claude
```

### API Key errors

**Problem**: `Missing API key` or `Authentication failed`

**Solution**:
```bash
# For Codex
export OPENAI_API_KEY="sk-..."

# For Claude
export ANTHROPIC_API_KEY="sk-ant-..."

# Or add to .env file
```

### Permission denied

**Problem**: Claude Code asks for permission

**Solution**:
- The system uses `--permission-mode bypassPermissions` for automation
- For interactive use, remove this flag
- Or configure permissions in Claude settings

---

## 📊 Agent Types Comparison

| Feature | Codex | Claude Code |
|---------|-------|-------------|
| **Provider** | OpenAI | Anthropic |
| **Best For** | Code generation | Full task automation |
| **Execution** | CLI pipe | CLI with flags |
| **File Access** | Limited | Full access |
| **Timeout** | 30s (configurable) | 60s (configurable) |
| **Output** | Text only | Text + files |

---

## 🔐 Security Considerations

### API Keys

- Store API keys in `.env` file (not committed to git)
- Use environment variables in production
- Rotate keys regularly

### Permissions

- Claude Code runs with `bypassPermissions` by default
- For production, configure proper permissions
- Review all file modifications

### Sandboxing

- Consider running agents in isolated environments
- Use Docker containers for untrusted tasks
- Monitor resource usage

---

## 📈 Performance Tips

### Timeout Configuration

```typescript
// In agent-executor.ts
const config = {
  timeout: 60000, // Increase for complex tasks
};
```

### Batch Execution

```typescript
// Execute multiple agents in parallel
const results = await executeTaskBatch(task, agentIds);
```

### Caching

- Cache agent responses for repeated tasks
- Use task hashes to detect duplicates
- Implement result deduplication

---

## 🎯 Next Steps

1. ✅ Install Codex and/or Claude Code
2. ✅ Configure API keys
3. ✅ Register agents via API
4. ✅ Create and execute test tasks
5. ⏳ Monitor performance
6. ⏳ Optimize configurations

---

## 📞 Support

- **Documentation**: Check `/docs` folder
- **Issues**: Create task with "bug" status
- **Questions**: Use communication agents

---

**Last Updated**: 2026-03-10  
**Version**: 1.0.0
