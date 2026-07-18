#!/usr/bin/env bash
# deploy.sh — 一条命令上线:ff-only 合 work/current → deploy + 按范围 rebuild/restart。
# 在哪跑都行;fork 专用(deploy worktree 固定在 /home/claw/deploy/hapi)。
# 规矩:只 ff-only,绝不产生 merge commit;deploy 不许直接 commit。
set -euo pipefail

DEPLOY_DIR=${HAPI_DEPLOY_DIR:-/home/claw/deploy/hapi}
SRC=${HAPI_DEPLOY_SOURCE:-work/current}

cd "$DEPLOY_DIR"

OLD=$(git rev-parse HEAD)
APPLIED_REF=refs/hapi/deploy-applied
if git show-ref --verify --quiet "$APPLIED_REF"; then
  APPLIED=$(git rev-parse "$APPLIED_REF")
else
  APPLIED=$OLD
  git update-ref "$APPLIED_REF" "$APPLIED"
fi
echo "==> deploy @ ${OLD:0:12}  ←  ff-only 合并 $SRC"
git merge --ff-only "$SRC"
NEW=$(git rev-parse HEAD)

if [ "$APPLIED" = "$NEW" ]; then
  echo "==> 已是最新 (${NEW:0:12}),无需部署。"
  exit 0
fi

echo "==> ${APPLIED:0:12} → ${NEW:0:12};检测尚未成功应用的改动..."
mapfile -t CHANGED < <(git diff --name-only "$APPLIED".."$NEW")

changed_package() {
  local package=$1
  local path
  for path in "${CHANGED[@]}"; do
    if [[ $path == "$package/"* ]]; then
      return 0
    fi
  done
  return 1
}

restart() { echo "==> 重启 $1"; systemctl --user restart "$1"; }

# web / shared 改了 → 重建 web(吃 deploy/web/dist)+ 重启 hapi-web
if changed_package web || changed_package shared; then
  echo "==> web/shared 改动 → build:web + 重启 hapi-web"
  bun run build:web
  restart hapi-web
fi

# hub / shared 改了 → 重启 hapi-hub(⚠️ 会打断在跑的 agent 会话)
if changed_package hub || changed_package shared; then
  echo "==> hub/shared 改动 → 重启 hapi-hub(⚠️ 打断在跑会话)"
  restart hapi-hub
fi

# cli 改动:新 session 是全新进程、直接读源码,自动走新代码,不用重启 runner。
if changed_package cli; then
  echo "==> cli 改动 → 新 session 自动生效(无需重启)"
  echo "    (想刷新 runner 守护进程:systemctl --user restart hapi-runner  ⚠️ 打断会话)"
fi

git update-ref "$APPLIED_REF" "$NEW" "$APPLIED"
echo "==> 完成。验证:hapi.zhetengde.xyz / localhost:5173(:3006)"
