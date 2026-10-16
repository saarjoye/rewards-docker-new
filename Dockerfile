FROM public.ecr.aws/docker/library/node:20-bookworm-slim

# 安装 tzdata、chromium 与中文字体支持
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-wqy-zenhei \
    tzdata \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# 先复制 package 文件以利用 Docker 层缓存
COPY package*.json ./

# 有 package-lock.json 时用 npm ci，构建结果可复现（不会因为依赖漂移导致线上行为变化）
RUN npm ci --omit=dev

# 复制源码与资源
COPY src/ ./src/

# 创建持久化数据目录
RUN mkdir -p /app/data

EXPOSE 5308

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5308/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

VOLUME ["/app/data"]

CMD ["npm", "start"]
