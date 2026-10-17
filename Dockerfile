FROM node:20-bookworm-slim

# 安装 tzdata、chromium、中文字体与 tini
#   - tini：容器 PID 1，负责回收 Chromium 产生的孤儿/僵尸进程。
#     没有它时 PID 1 是 npm，npm 不具备 reap 能力，每次浏览器任务结束后
#     都会在 PID 表里留下 chrome_crashpad/chromium 僵尸（实测一次任务残留 35+ 个）。
#   - fonts-wqy-zenhei：中文字体支持。
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-wqy-zenhei \
    tzdata \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV CHROMIUM_PATH=/usr/bin/chromium

# compose 的 init:true 会先注入 docker-init 作为 PID 1，此时镜像内的 tini 成为子进程。
# 只有注册为 subreaper，tini 才能收养并回收 Chromium 的孤儿进程；
# 否则它会输出 "Tini is not running as PID 1" 并且完全不起作用（实测）。
ENV TINI_SUBREAPER=1

# 构建时注入提交号，供面板显示「容器里跑的是哪次提交」
ARG MSR_BUILD_REVISION=dev
ARG MSR_BUILD_TIME=
ENV MSR_BUILD_REVISION=${MSR_BUILD_REVISION}
ENV MSR_BUILD_TIME=${MSR_BUILD_TIME}

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

# 用 tini 作为 PID 1：转发信号 + 回收孤儿进程。
# 直接 exec node（而非 npm start），少一层 npm 进程：
#   - SIGTERM 直达应用，优雅退出更快；
#   - 即使不依赖 --init 也能回收 Chromium 的子进程。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
