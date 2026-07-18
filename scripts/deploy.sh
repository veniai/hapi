#!/usr/bin/env bash
# deploy.sh — 一条命令上线:ff-only 合 work/current → deploy + 按范围 rebuild/restart。
# 在哪跑都行;fork 专用(deploy worktree 固定在 /home/claw/deploy/hapi)。
# 规矩:只 ff-only,绝不产生 merge commit;deploy 不许直接 commit。
set -euo pipefail

DEPLOY_DIR=/home/claw/deploy/hapi
SRC=work/current

cd "$DEPLOY_DIR"

OLD=$(git rev-parse --short HEAD)
echo "==> deploy @ $OLD  ←  ff-only 合并 $SRC"
git merge --ff-only "$SRC"
NEW=$(git rev-parse --short HEAD)

if [ "$OLD" = "$NEW" ]; then
  echo "==> 已是最新 ($NEW),无需部署。"
  exit 0
fi

echo "==> $OLD → $NEW;检测改了哪些包..."
CHANGED=$(git diff --name-only "$OLD".."$NEW")

restart() { echo "==> 重启 $1"; systemctl --user restart "$1"; }

# web / shared 改了 → 重建 web(吃 deploy/web/dist)+ 重启 hapi-web
if echo "$CHANGED" | grep -qE '^(web|shared)/'; then
  echo "==> web/shared 改动 → build:web + 重启 hapi-web"
  bun run build:web
  restart hapi-web
fi

# hub / shared 改了 → 重启 hapi-hub(⚠️ 会打断在跑的 agent 会话)
if echo "$CHANGED" | grep -qE '^(hub|shared)/'; then
  echo "==> hub/shared 改动 → 重启 hapi-hub(⚠️ 打断在跑会话)"
  restart hapi-hub
fi

# cli 改动:新 session 是全新进程、直接读源码,自动走新代码,不用重启 runner。
if echo "$CHANGED" | grep -qE '^cli/'; then
  echo "==> cli 改动 → 新 session 自动生效(无需重启)"
  echo "    (想刷新 runner 守护进程:systemctl --user restart hapi-runner  ⚠️ 打断会话)"
fi

echo "==> 完成。验证:hapi.zhetengde.xyz / localhost:5173(:3006)"
