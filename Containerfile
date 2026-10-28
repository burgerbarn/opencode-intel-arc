FROM ghcr.io/anomalyco/opencode:1.19.4
RUN apk add --no-cache git bash nodejs npm python3 py3-pip curl openssh-client
RUN npm install -g mcp-searxng@2.9.0
