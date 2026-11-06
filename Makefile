GO := $(shell command -v go 2>/dev/null || echo $(HOME)/.goenv/shims/go)
.PHONY: build linux release deploy portal rollback releases

build:
	npm --prefix web run build
	$(GO) build -trimpath -o bin/curio ./cmd/curio

linux:
	npm --prefix web run build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -o bin/curio-linux-amd64 ./cmd/curio

release:
	bash deploy/release.sh build

deploy:
	bash deploy/release.sh deploy

portal:
	bash deploy/release.sh portal

rollback:
	bash deploy/release.sh rollback $(COMMIT)

releases:
	bash deploy/release.sh list
