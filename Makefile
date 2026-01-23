.PHONY: git-quick git-status

git-status:
	@git status

git-quick:
	@set -e; \
	BRANCH="$${BRANCH:-$$(git rev-parse --abbrev-ref HEAD)}"; \
	MSG="$${COMMIT_MSG:-updated}"; \
	git status; \
	git add .; \
	if git diff --cached --quiet; then \
		echo "Nothing to commit."; \
	else \
		git commit -m "$$MSG"; \
	fi; \
	git push -u origin "$$BRANCH"
