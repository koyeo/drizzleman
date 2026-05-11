.PHONY: install build link unlink clean

install: build link

build:
	pnpm install
	pnpm build

link:
	npm link

unlink:
	npm unlink -g drizzleman || true

clean:
	rm -rf dist node_modules
