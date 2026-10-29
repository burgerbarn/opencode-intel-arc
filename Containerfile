FROM ghcr.io/anomalyco/opencode:1.19.4
RUN apk add --no-cache git bash nodejs npm python3 py3-pip curl openssh-client
RUN npm install -g mcp-searxng@2.9.0
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz | tar xz -C /tmp && mv /tmp/gh_2.103.3_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh_2.103.3_linux_amd64
