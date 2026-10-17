#!/usr/bin/env bash
# 容器内存/进程诊断脚本（在部署 ms-rewards 的那台宿主机上执行）
#
# 用途：把「浏览器已经不跑了，但内存/PID 还是很高」这件事定量拆开。
# 输出四块：docker stats、进程 RSS、cgroup 明细、僵尸进程统计。
#
# 用法:
#   bash diagnose.sh            # 只看当前
#   bash diagnose.sh before     # 任务前打点
#   bash diagnose.sh after      # 任务后打点（等 60s 让浏览器收尾）
#   diff <(bash diagnose.sh before) <(bash diagnose.sh after)

set -u
NAME="${MSR_NAME:-ms-rewards}"

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "找不到运行中的容器 $NAME（可用 MSR_NAME=xxx 覆盖）" >&2
  exit 1
fi

echo "===== 1. docker stats ====="
docker stats --no-stream "$NAME"

echo
echo "===== 2. 进程 RSS Top20（STAT 列：Z=僵尸） ====="
docker exec "$NAME" sh -c 'ps -eo pid,ppid,rss,stat,comm --sort=-rss | head -21'

echo
echo "===== 3. cgroup 内存明细 ====="
docker exec "$NAME" sh -c '
  if [ -r /sys/fs/cgroup/memory.current ]; then
    cur=$(cat /sys/fs/cgroup/memory.current)
    echo "memory.current = $cur bytes ($((cur/1024/1024)) MiB)"
    echo "--- memory.stat（关键项）---"
    for k in anon file kernel kernel_stack slab shmem inactive_anon active_anon inactive_file active_file; do
      v=$(grep -m1 "^$k " /sys/fs/cgroup/memory.stat | awk "{print \$2}")
      [ -n "$v" ] && printf "%-16s %12d bytes  %6d MiB\n" "$k" "$v" "$((v/1024/1024))"
    done
  else
    echo "无 cgroup v2，退回 v1"
    cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null
  fi
'

echo
echo "===== 4. 僵尸进程统计 ====="
docker exec "$NAME" sh -c '
  total=0; zom=0; znames=""
  for p in /proc/[0-9]*; do
    [ -r "$p/status" ] || continue
    total=$((total+1))
    if grep -q "^State:[[:space:]]*Z" "$p/status"; then
      zom=$((zom+1))
      znames="$znames $(grep -m1 "^Name:" "$p/status" | cut -f2)"
    fi
  done
  echo "进程总数 = $total"
  echo "僵尸进程 = $zom"
  [ "$zom" -gt 0 ] && echo "僵尸名单(前 20):$znames" | cut -c1-400
  echo
  if [ "$zom" -gt 50 ]; then
    echo "⚠️  僵尸偏多。若容器已有 --init/tini 仍如此，说明是宿主内核或 PID1 未生效。"
  elif [ "$zom" -gt 0 ]; then
    echo "ℹ️  有少量僵尸。加 --init（compose init: true）后应稳定在 0。"
  else
    echo "✅ 无僵尸进程。"
  fi
'

echo
echo "===== 5. 事件增量采样（可选，10 秒）====="
echo "对比同一账号一次搜索任务前后，关注 memory.current 的 anon 与僵尸数是否回落。"
