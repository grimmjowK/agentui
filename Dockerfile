# CloudCLI UI + POPO Bot 多阶段构建
# 阶段 1: 构建前端和后端
FROM ncr.nie.netease.com/mirror_docker.io/library/node:22-slim AS builder

WORKDIR /app

# 安装构建依赖（native modules: better-sqlite3, node-pty, bcrypt）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# 阶段 2: 运行时
FROM ncr.nie.netease.com/mirror_docker.io/library/node:22-slim

WORKDIR /app

# 安装运行时系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    build-essential \
    sqlite3 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# 安装 popo-cli
RUN curl -fsSL https://popo.update.netease.com/popo_cli_install.sh -o /tmp/popo_cli_install.sh && bash /tmp/popo_cli_install.sh && rm -f /tmp/popo_cli_install.sh

# 复制构建产物和生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY shared/ ./shared/
COPY server/ ./server/
COPY scripts/ ./scripts/

# 安装 POPO bot Python 依赖
RUN python3 -m venv /app/.venv && \
    /app/.venv/bin/pip install --no-cache-dir \
    requests websocket-client pycryptodome

# 将本地 popo_sdk 安装到 venv
RUN cd /app/scripts/popo-oapi-sdk-python-master && \
    /app/.venv/bin/pip install --no-cache-dir -e .

# 数据目录（SQLite 数据库、session 工作目录）
RUN mkdir -p /data/db /data/popo-sessions /root/.claude/popo-sessions

# Codex 配置目录（运行时挂载）
RUN mkdir -p /root/.codex

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV VITE_IS_PLATFORM=true
ENV DATABASE_PATH=/data/db/auth.db

EXPOSE 3001

# 默认启动 CloudCLI server（POPO bot 通过 docker-compose 独立启动）
CMD ["node", "dist-server/server/index.js"]
