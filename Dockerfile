# Sandbox base image. The tag MUST match the @cloudflare/sandbox npm version
# (see package.json). The SDK verifies version compatibility on startup.
FROM docker.io/cloudflare/sandbox:0.12.3

# Claude Code CLI - the agent that reads the issue and writes the fix.
RUN npm install -g @anthropic-ai/claude-code

# GitHub CLI - used by the agent to open the Pull Request.
# git is already present in the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
