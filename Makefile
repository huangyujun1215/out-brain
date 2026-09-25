SHELL := /bin/bash
COMPOSE ?= docker compose

.PHONY: help setup up down reset ps logs build typecheck test integration e2e verify

help:
	@printf '%s\n' \
	  'make setup        Copy .env.example to .env (does not overwrite)' \
	  'make up           Build and start the complete stack' \
	  'make down         Stop the stack and preserve data' \
	  'make reset        Stop and permanently remove local data volumes' \
	  'make ps           Show container health' \
	  'make logs         Follow API, Worker and Web logs' \
	  'make typecheck    Run TypeScript checks' \
	  'make test         Run unit and contract tests' \
	  'make integration  Run integration tests against the running stack' \
	  'make e2e          Run Playwright tests against the running stack' \
	  'make verify       Run all automated checks'

setup:
	@if test -f .env; then echo '.env already exists; leaving it unchanged.'; else cp .env.example .env && echo 'Created .env. Configure LLM_API_KEY and replace both JWT secrets.'; fi
	@chmod 600 .env

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f api worker web

build:
	pnpm build

typecheck:
	pnpm typecheck

test:
	pnpm test

integration:
	set -a; source .env; set +a; pnpm test:integration

e2e:
	pnpm test:e2e

verify: typecheck test integration e2e
