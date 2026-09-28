#!/usr/bin/env bash
# Publish a build to the gh-pages branch without clobbering other deploys.
#
# Usage:
#   publish-gh-pages.sh root <dir>     main demo at the site root, keeps pr-*/ previews
#   publish-gh-pages.sh pr-<n> <dir>   preview of PR <n> under pr-<n>/
#   publish-gh-pages.sh pr-<n>         remove the preview of PR <n>
#
# Env: GITHUB_TOKEN (contents: write), DEPLOY_REPOSITORY (owner/repo),
# DEPLOY_BRANCH (default gh-pages), DEPLOY_REMOTE (optional git URL override, for tests).
set -euo pipefail

target="$1"
src="${2:-}"
repo="${DEPLOY_REPOSITORY:?}"
branch="${DEPLOY_BRANCH:-gh-pages}"
remote="${DEPLOY_REMOTE:-https://x-access-token:${GITHUB_TOKEN:?}@github.com/${repo}.git}"
site="$(mktemp -d)"

if git ls-remote --exit-code --heads "$remote" "$branch" > /dev/null; then
  git clone --quiet --depth 1 --branch "$branch" "$remote" "$site"
else
  git init --quiet "$site"
  git -C "$site" checkout --quiet --orphan "$branch"
  git -C "$site" remote add origin "$remote"
fi

case "$target" in
  root)
    [ -d "$src" ] || { echo "missing build dir: $src" >&2; exit 1; }
    # --delete clears stale hashed assets; excluded pr-*/ previews are kept.
    rsync -a --delete --exclude '.git' --exclude 'pr-*/' "$src"/ "$site"/
    ;;
  pr-[0-9]*)
    rm -rf "${site:?}/$target"
    if [ -n "$src" ]; then
      mkdir -p "$site/$target"
      rsync -a "$src"/ "$site/$target"/
    fi
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 1
    ;;
esac

touch "$site/.nojekyll"

cd "$site"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to publish for $target"
  exit 0
fi
git -c user.name=github-actions-bot -c user.email=support+actions@github.com \
  commit --quiet -m "Deploy $target"

# Previews and the main demo write different paths, so a rebase on a
# concurrent deploy never conflicts. Retry instead of serializing the jobs.
for attempt in 1 2 3 4 5; do
  if git push --quiet origin "$branch"; then
    echo "Published $target to $repo@$branch"
    exit 0
  fi
  echo "Push rejected (attempt $attempt), rebasing on the latest $branch"
  git pull --quiet --rebase origin "$branch"
done
echo "Could not push $target after 5 attempts" >&2
exit 1
