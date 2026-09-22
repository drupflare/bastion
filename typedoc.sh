#!/usr/bin/env bash
set -euo pipefail

# Publishes the TypeDoc output to the root of gh-pages.
# Usage: bash typedoc.sh <short-sha>

# build-typedoc rather than typedoc or docs: gh-pages carries the published output at its root, so a
# build directory named after anything the branch tracks would be checked over by 'git switch -f'
# and then deleted on the way back.
HTML_DIR="${TYPEDOC_HTML_DIR:-build-typedoc}"

if [[ ! -d $HTML_DIR ]]; then
	echo "no TypeDoc output at $HTML_DIR; run 'bun run docs:api' first" >&2
	exit 1
fi

# -c rather than 'git config --local', which writes into .git/config and stays there
commit_as=(-c "user.email=action@github.com" -c "user.name=GitHub Action")

start="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
tmpdir="$(mktemp -d)"
# always restored, so a failed deploy does not leave the checkout sitting on gh-pages
trap 'rm -rf "$tmpdir"; git switch -f -q "$start" 2> /dev/null || true' EXIT

cp -R "$HTML_DIR/." "$tmpdir/typedoc"

first_deploy=0
if git fetch origin gh-pages 2> /dev/null; then
	git branch --no-track -f gh-pages origin/gh-pages 2> /dev/null || true
	git switch -f gh-pages
elif git show-ref --verify --quiet refs/heads/gh-pages; then
	git switch -f gh-pages
else
	# a first deploy has nothing to branch from, so start an orphan rather than force-pushing
	first_deploy=1
	git switch --orphan gh-pages
fi

if [[ $first_deploy -eq 0 ]]; then
	# the previous deploy leaves its files in the working tree, and a page this build no longer emits
	# would otherwise survive inside a directory the new one reuses
	git ls-files -z | while IFS= read -r -d '' tracked; do rm -f "$tracked"; done
fi

# --orphan keeps the source branch's index and a switch onto gh-pages brings the old output into it;
# either way the commit is built only from what is added below
git rm -rq --cached . 2> /dev/null || true

cp -R "$tmpdir/typedoc/." .

# scoped rather than 'git add -A': the working tree still holds source and node_modules, and
# gh-pages carries no .gitignore to keep them out
published=()
while IFS= read -r -d '' entry; do
	published+=("${entry#"$tmpdir/typedoc/"}")
done < <(find "$tmpdir/typedoc" -mindepth 1 -maxdepth 1 -print0)
git add -A -- "${published[@]}"

if git diff --cached --quiet; then
	echo "No TypeDoc changes to deploy."
	exit 0
fi

git "${commit_as[@]}" commit -m "Update TypeDoc ($1)"
# the branch was built on origin/gh-pages, so this fast-forwards and never needs -f
git push origin gh-pages
